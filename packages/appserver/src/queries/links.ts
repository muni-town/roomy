/**
 * Link index aggregation helper.
 *
 * Serves the per-room and per-space links views (`space.roomy.room.getLinks`
 * and `space.roomy.space.getLinks`): a paginated, newest-first, URL-deduped
 * list of every shared link in a scope, each carrying the room it was shared
 * in, the message that shared it, and its enriched card (when the embed
 * enricher produced one).
 *
 * ## Data model (do not re-derive blindly)
 *
 * A link's `comp_embed_link.entity` is the URL, but that row does NOT say
 * which room the link lives in. Two distinct representations coexist:
 *
 * 1. **Body URLs** (detected from message content / richtext `#link`
 *    facets) are materialised ONCE per space: `comp_embed_link.entity` is the
 *    bare URL (via `insert or ignore`), and the link's `entities.room` holds
 *    the MESSAGE id that first shared it — not the room id. Resolving the
 *    room thus requires the two-hop join `link.room -> message.id -> msg.room`.
 *    The `comp_embed_link_data` row for enrichment is keyed by the same bare
 *    URL.
 * 2. **Attachment links** (`space.roomy.attachment.link.v0`) create a
 *    per-message encoded entity `url?message=<messageId>`, whose `entities.room`
 *    is that message id. These are the "same URL in ten messages → ten rows"
 *    case that URL dedup collapses.
 *
 * So dedup by URL is not optional: the same URL can appear under several
 * `comp_embed_link` rows when some were attachment-encoded.
 *
 * > Note: link `entities.stream_id` is `''` (see `detectAndStoreLinks`), so
 * > space scoping must filter on the MESSAGE entity's `stream_id` (= space
 * > DID), not the link entity's.
 *
 * ## Ordering key
 *
 * Rows are ordered by the containing message's `sort_idx` (the message's
 * ordering key — its receipt time, or a bridge-supplied `timestampOverride` —
 * falling back to the message id when `sort_idx` is null) descending,
 * tie-broken by URL. This matches the timeline ordering used by
 * `selectMessages` and `activity_item`, so "newest shared link first" agrees
 * with the message the user actually sees. `sort_idx` is preferred over the
 * message entity's `created_at` because it is the timeline key the read path
 * pages on (a moved message is re-keyed by its move event, and edits preserve
 * it), whereas `created_at` is the row-creation wallclock that a batch
 * materialisation skews.
 *
 * Cursor format: `"<sort_key>::<url>"` (URLs are compared verbatim; cursor
 * ties use the URL as the second key).
 *
 * The caller is responsible for filtering by read access — this helper does
 * not check permissions.
 */

import { decodeTime } from "ulidx";
import type { DbLike } from "../db/types.ts";
import { selectEmbedJsonByUrl } from "../embed/store.ts";

export interface LinkDto {
  /** The shared URL. */
  url: string;
  /** The room the link was shared in (the real room id, not the message id). */
  roomId: string;
  /** The message that shared the link. */
  messageId: string;
  /** Canonical message sort key (ULID of the message's canonical time). */
  sort_key: string;
  /** Enriched card data (EmbedV1 JSON), null when the enricher had no data. */
  embed: string | null;
}

export type LinkScope =
  | { kind: "space"; spaceId: string }
  | { kind: "room"; roomId: string };

export interface RawLinkRow {
  url: string;
  room_id: string;
  message_id: string;
  sort_key: string;
  embed_json: string | null;
  /**
   * The DID of the author of `message_id` (the message that shared the URL),
   * or `''` when the message carries no author edge. The caller redacts rows
   * whose author is hidden from the viewer (§ user blocks).
   */
  author_did?: string;
}

/**
 * Fetch up to `limit` links in scope, newest-first by the containing
 * message's `sort_idx`. Returns one row per `comp_embed_link` entity:
 * attachment-encoded duplicates of the same URL are NOT yet collapsed here —
 * `dedupeLinks` does that. `hasMore` reports whether more than `limit` raw
 * rows existed (before dedup), so callers can decide whether a next page is
 * available without over-fetching.
 *
 * `embed_json` is null on every row: the enrichment lives in the global
 * `link_embeds` store, keyed by URL, and a per-space statement cannot reach
 * another database. `hydrateLinkEmbeds` fills it from the store once the page
 * has been deduped, so the values come from the URLs that survive pagination
 * rather than from every row the page over-fetched.
 */
export async function listLinks(
  db: DbLike,
  scope: LinkScope,
  limit = 50,
  cursor?: string | null,
): Promise<{ links: RawLinkRow[]; hasMore: boolean }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Space scope filters on the MESSAGE entity's stream_id (the link entity's
  // stream_id is '' — see module doc).
  if (scope.kind === "space") {
    conditions.push("msg.stream_id = ?");
    params.push(scope.spaceId);
  } else {
    conditions.push("msg.room = ?");
    params.push(scope.roomId);
  }

  // Restrict to link entities that actually have a comp_embed_link row (the
  // `entities` table also holds messages, rooms, users, media, …).
  conditions.push("el.entity is not null");
  conditions.push("msg.room is not null");

  // Newest-first by the message's sort key, tie-broken by URL.
  if (cursor) {
    const sepIdx = cursor.lastIndexOf("::");
    if (sepIdx !== -1) {
      const cursorKey = cursor.slice(0, sepIdx);
      const cursorUrl = cursor.slice(sepIdx + 2);
      // A row sorts AFTER the cursor when its sort_key is strictly smaller,
      // OR the sort_key matches and the tie-break URL is strictly greater.
      conditions.push(
        "(coalesce(msg.sort_idx, msg.id) < ? or (coalesce(msg.sort_idx, msg.id) = ? and el.entity > ?))",
      );
      params.push(cursorKey, cursorKey, cursorUrl);
    }
  }

  const whereClause = conditions.join(" and ");

  const rows = await db
    .query(
      `select el.entity as url,
              msg.room as room_id,
              link.room as message_id,
              coalesce(msg.sort_idx, msg.id) as sort_key,
              coalesce(author_e.tail, '') as author_did
         from entities link
         join entities msg on msg.id = link.room
         left join edges author_e on author_e.head = msg.id and author_e.label = 'author'
         left join comp_embed_link el on el.entity = link.id
        where ${whereClause}
        order by sort_key desc, el.entity asc
        limit ?`,
    )
    .all<{
      url: string;
      room_id: string;
      message_id: string;
      sort_key: string;
      author_did: string;
    }>([...params, limit + 1]);

  if (rows.length === 0) return { links: [], hasMore: false };

  const hasMore = rows.length > limit;
  const links = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    ...r,
    embed_json: null,
  })) as RawLinkRow[];
  return { links, hasMore };
}

/**
 * Fill each row's `embed_json` from the global `link_embeds` store.
 *
 * The store is keyed by the canonical URL, while a body-URL row's `url` is
 * that same bare URL and an attachment link's is `url?message=<id>`. Look up
 * by {@link canonicalUrl}; the row keeps its own `url` for display and for
 * paging. Call AFTER deduping — the page over-fetches by one row and collapses
 * attachment-encoded duplicates, so this binds the URLs that are actually
 * served rather than every raw row the query returned.
 *
 * A row with no store entry keeps a null `embed_json`, which the handlers read
 * as "no card" — the correct render for a URL the enricher has not reached.
 */
export async function hydrateLinkEmbeds(
  globalDb: DbLike,
  rows: RawLinkRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const canonical = rows.map((r) => canonicalUrl(r.url));
  const stored = await selectEmbedJsonByUrl(globalDb, canonical);
  rows.forEach((row, i) => {
    row.embed_json = stored.get(canonical[i]!) ?? null;
  });
}

/**
 * Strip Roomy's attachment encoding (`?message=<ulid>`) to recover the
 * canonical URL. The suffix is machine-appended by the SDK materialiser; a
 * user-supplied query param that happens to match the pattern would be
 * stripped too, but that is an acceptable edge case for a dedup key (the
 * display URL is untouched — dedup only affects what appears as one link).
 */
const MESSAGE_SUFFIX = /[?&]message=[0-9A-HJKMNP-TV-Z]{26}$/;

export function canonicalUrl(url: string): string {
  return url.replace(MESSAGE_SUFFIX, "");
}

/**
 * Canonical URLs of the `space.roomy.attachment.link.v0` attachments a message
 * carries. An attachment link materialises as its own entity with the message
 * id encoded into the URL (`?message=<ulid>`), while the embed store is keyed
 * by the bare URL, so the encoding must not reach the enrichment queue.
 */
export function linkAttachmentUrls(
  extensions: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const attachments = (
    extensions?.["space.roomy.extension.attachments.v0"] as
      | { attachments?: ReadonlyArray<{ $type?: string; uri?: string }> }
      | undefined
  )?.attachments;
  if (!attachments) return [];
  const urls: string[] = [];
  for (const att of attachments) {
    if (att.$type === "space.roomy.attachment.link.v0" && typeof att.uri === "string") {
      urls.push(canonicalUrl(att.uri));
    }
  }
  return urls;
}

/**
 * Build the next-page cursor from the last deduped row (or null at the end).
 * Cursor format: `"<sort_key>::<url>"` — the inverse of `listLinks`'s cursor
 * parsing. `undefined` (an empty page after dedup) yields null.
 */
export function cursorForRow(row: RawLinkRow | undefined): string | null {
  if (!row) return null;
  return `${row.sort_key}::${row.url}`;
}

/**
 * Derive a link's display timestamp from its canonical ordering key
 * (`coalesce(msg.sort_idx, msg.id)`).
 *
 * That key IS the timeline position the server orders by — arrival-aware,
 * bridge-override-correct and move-aware (see "Ordering key" above) — so
 * decoding it yields the time the user associates with the message that
 * shared the link. The message's `created_at` and its content timestamp both
 * diverge from this for live/bridged messages; the ordering key does not.
 *
 * Guarded: `decodeTime` reads only the first 10 Crockford-base32 chars, which
 * are always valid for these keys, but a malformed key must degrade to "no
 * date" rather than emit NaN / an Invalid Date — so a throw or non-finite
 * result yields `undefined`.
 */
export function linkTimestamp(sortKey: string): string | undefined {
  try {
    const ms = decodeTime(sortKey);
    if (!Number.isFinite(ms)) return undefined;
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Collapse duplicate canonical URLs, keeping the newest (first in the
 * newest-first `rows` order) occurrence for each.
 *
 * The body-URL materialisation already dedups per space (one row per bare
 * URL), so this chiefly dedups attachment-encoded rows
 * (`url?message=<id>`) that share a canonical URL with the bare row or with
 * another attachment row.
 *
 * Ordering is preserved: each URL's newest row keeps its position, and
 * dropped duplicates vanish entirely. Call after access-filtering (so a URL
 * seen in a readable room is never dropped in favour of an unreadable one).
 */
export function dedupeLinks(rows: RawLinkRow[]): RawLinkRow[] {
  const seen = new Set<string>();
  const out: RawLinkRow[] = [];
  for (const r of rows) {
    const canonical = canonicalUrl(r.url);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(r);
  }
  return out;
}
