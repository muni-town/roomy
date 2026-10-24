/**
 * Activity feed query helper.
 *
 * Reads from the `activity_item` table (materialized on createMessage events)
 * and joins the recent message IDs against the full message data at query time.
 *
 * Results are sorted newest-first and support cursor-based pagination.
 * The caller is responsible for filtering by room-level read access.
 */

import type { DbLike } from "../db/types.ts";
import type { UserDid } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";
import { decodeContent } from "../db/content.ts";
import { openSpaceDb } from "../db/db.ts";
import { selectEmbedJsonByUrl } from "../embed/store.ts";
import {
  attachmentFromEmbedRow,
  deriveAttachmentViews,
  type AttachmentDto,
  type EmbedRow,
} from "./selectMessages.ts";
import { canonicalUrl } from "./links.ts";
import { hydrateProfiles } from "./profileStore.ts";
import { selectJoinedSpaceDids } from "./userSpaceMembership.ts";
import { deriveUnreadCounts } from "./readPositions.ts";
import { hiddenBy } from "./userBlocks.ts";

// ─── Types ────────────────────────────────────────────────────────────────

export interface ActivityAuthor {
  did: string;
  name?: string;
  handle?: string;
  avatar?: string;
}

export interface ActivityMessage {
  id: string;
  content: string;
  /**
   * MIME type of the content blob. `text/markdown` for legacy messages,
   * `application/vnd.roomy.richtext+json` for blocks+facets messages.
   */
  mimeType?: string;
  author: ActivityAuthor;
  timestamp?: string;

  /**
   * Every attachment on the message, one entry per row, discriminated by
   * `$type` — the same shape the message read path returns. Only hydrated on
   * the latest message of each feed item, like the derived views below.
   */
  attachments?: Array<AttachmentDto>;
  /** Reactions on the message. Only hydrated on the latest message. */
  reactions?: Array<{ emoji: string; count: number; myReactionId?: string }>;
  /**
   * Derived from `attachments`. Only hydrated on the latest message of each
   * feed item.
   */
  media?: Array<{ url: string; type: string; alt?: string; width?: number; height?: number; blurhash?: string; size?: number; length?: number; name?: string }>;
  /** Derived from `attachments`: the link rows, with enriched metadata. */
  linkEmbeds?: Array<{ url: string; embed?: Record<string, unknown> }>;
}

export interface ActivityFeedItem {
  threadId: string;
  threadName?: string;
  spaceId: string;
  spaceName?: string;
  spaceAvatar?: string;
  channelId?: string;
  channelName?: string;
  lastActivityAt: string;
  activityType: "message";
  messages: ActivityMessage[];
  unreadCount: number;
}

export interface ActivityFeedScope {
  /** Optional space filter. When absent, all joined spaces. */
  spaceId?: string;
  limit: number;
  /** Cursor: "timestamp::roomId" of the last item on the previous page. */
  cursor: string | null;
}

/**
 * Parse the `recent_message_ids` JSON column into `{ id, ts }` entries
 * (newest first). The column stores objects so the window can be ordered by
 * canonical message time — the message ULID alone encodes bridge-ingestion
 * time for Discord-bridged messages, not the original Discord send time.
 * Legacy rows (plain ULID strings) are tolerated: they decode to the ULID
 * time, the best timestamp available for them.
 */
function parseRecentMessageIds(raw: string): Array<{ id: string; ts: number }> {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const entries: Array<{ id: string; ts: number }> = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      // Legacy rows store plain ULID strings. Tolerate malformed IDs
      // (e.g. ghost rows) — they decode to 0 and are skipped downstream.
      let ts = 0;
      try {
        ts = decodeTime(item);
      } catch {
        // not a valid ULID — keep ts 0
      }
      entries.push({ id: item, ts });
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    const id = (item as Record<string, unknown>).id;
    const ts = (item as Record<string, unknown>).ts;
    if (typeof id === "string" && typeof ts === "number") {
      entries.push({ id, ts });
    }
  }
  return entries;
}

// ─── Query ────────────────────────────────────────────────────────────────

/** Raw `activity_item` row shape, shared across the per-space fan-out. */
interface ActivityItemRow {
  room_id: string;
  space_id: string;
  is_thread: number;
  parent_channel_id: string | null;
  parent_channel_name: string | null;
  last_activity_at: number;
  recent_message_ids: string;
  room_name: string | null;
  space_name: string | null;
  space_avatar: string | null;
}

const ACTIVITY_ITEM_COLUMNS = `
     ai.room_id, ai.space_id, ai.is_thread,
     ai.parent_channel_id, ai.parent_channel_name,
     ai.last_activity_at, ai.recent_message_ids,
     ai.room_name, ai.space_name, ai.space_avatar
`;

/** Filter out deleted rooms. */
const NOT_DELETED = "(cr.deleted is null or cr.deleted = 0)";

/**
 * Spaces whose DBs are queried at once by one feed request. A request fans out
 * over every joined space, so without a bound a user in many spaces would open
 * a connection per space in one call and evict the rest from the worker's
 * per-space cache (`DEFAULT_MAX_SPACE_DBS` in `db/bounds.ts`), which is what
 * serves every other space on that worker.
 */
export const SPACE_FANOUT_CONCURRENCY = 8;

/**
 * Run `fn` over `items` with at most `limit` invocations in flight, returning
 * the results in input order. A rejection stops the result but not the calls
 * already running: like the serial loops it replaces, a space that fails fails
 * the whole feed.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Where the fan-out gets a space's handle. Production always opens the real
 * per-space DB; a test overrides it to count the calls in flight (see
 * `_setTestSpaceDbOpener`).
 */
let spaceDbFor: (spaceDid: string) => DbLike = openSpaceDb;

/**
 * Test-only: observe or substitute the per-space handles the fan-out reads.
 * Pass null to restore `openSpaceDb`.
 */
export function _setTestSpaceDbOpener(
  fn: ((spaceDid: string) => DbLike) | null,
): void {
  spaceDbFor = fn ?? openSpaceDb;
}

/**
 * Select the activity feed by fanning out to per-space DBs.
 *
 * `mainDb` is the READ-STATE handle, used ONLY for the read-state watermark
 * query (read_positions lives in the read-state DB); the unread counts are
 * derived from those watermarks against the per-space DBs. All other reads go
 * against the per-space DBs, one per joined space.
 */
export async function selectActivityFeed(
  mainDb: DbLike,
  userDid: string,
  scope: ActivityFeedScope,
  /**
   * The global `link_embeds` store. Optional for the same reason as in
   * `selectMessages`: a per-space handle cannot reach it, so the caller that
   * holds the global handle passes it and one that does not renders bare
   * links.
   */
  linkEmbedDb?: DbLike | null,
): Promise<{
  feed: ActivityFeedItem[];
  cursor: string | null;
  /** Space DBs the fan-out covered, whether or not they held any rows. */
  spaceCount: number;
}> {
  // Step 0: determine the set of space DIDs from durable membership intent.
  let spaceDids: string[];
  if (scope.spaceId) {
    spaceDids = [scope.spaceId];
  } else {
    spaceDids = await selectJoinedSpaceDids(mainDb, userDid);
  }

  if (spaceDids.length === 0) return { feed: [], cursor: null, spaceCount: 0 };

  // Step 1: fan out to per-space DBs, fetching a page of rows per space
  // (newest first) so we can merge and paginate globally. The per-space pages
  // are independent, so they are fetched concurrently — bounded, because each
  // one opens that space's DB on the worker.
  const pages = await mapBounded(spaceDids, SPACE_FANOUT_CONCURRENCY, (spaceDid) =>
    spaceDbFor(spaceDid)
      .query(
        `select ${ACTIVITY_ITEM_COLUMNS}
         from activity_item ai
         left join comp_room cr on cr.entity = ai.room_id
         where ai.space_id = ? and ${NOT_DELETED}
         order by ai.last_activity_at desc, ai.room_id desc
         limit ?`,
      )
      .all<ActivityItemRow>([spaceDid, scope.limit + 1]),
  );
  const allRows: ActivityItemRow[] = pages.flat();

  if (allRows.length === 0) return { feed: [], cursor: null, spaceCount: spaceDids.length };

  // Step 2: merge + sort (newest-first, tie-break by room id descending).
  allRows.sort((a, b) => {
    if (a.last_activity_at !== b.last_activity_at) {
      return b.last_activity_at - a.last_activity_at;
    }
    return b.room_id < a.room_id ? -1 : b.room_id > a.room_id ? 1 : 0;
  });

  // Step 3: apply the cursor ("timestamp::roomId") — keep rows strictly after it.
  let filtered = allRows;
  if (scope.cursor) {
    const sepIdx = scope.cursor.lastIndexOf("::");
    if (sepIdx !== -1) {
      const cursorTs = Number(scope.cursor.slice(0, sepIdx));
      const cursorId = scope.cursor.slice(sepIdx + 2);
      if (!Number.isNaN(cursorTs)) {
        filtered = allRows.filter((r) =>
          r.last_activity_at < cursorTs ||
          (r.last_activity_at === cursorTs && r.room_id < cursorId),
        );
      }
    }
  }

  // Step 4: paginate.
  const hasMore = filtered.length > scope.limit;
  const pageRows = hasMore ? filtered.slice(0, scope.limit) : filtered;
  if (pageRows.length === 0) return { feed: [], cursor: null, spaceCount: spaceDids.length };

  // The author DIDs hidden from this viewer by a block, in either direction.
  // Resolved once for the page so the message fetch below drops a hidden
  // author before its body, name or avatar is read.
  const hidden = await hiddenBy(userDid as UserDid);

  // Step 5: batch-fetch full message data per space, merging into a shared map.
  const messagesData = new Map<string, ActivityMessage>();
  const bySpace = new Map<string, ActivityItemRow[]>();
  for (const r of pageRows) {
    let arr = bySpace.get(r.space_id);
    if (!arr) {
      arr = [];
      bySpace.set(r.space_id, arr);
    }
    arr.push(r);
  }
  // Spaces are fetched concurrently, bounded for the same reason as step 1.
  // A space with no message IDs is skipped rather than queried, as before.
  const fetchedBySpace = await mapBounded([...bySpace], SPACE_FANOUT_CONCURRENCY, async ([spaceDid, rows]) => {
    const msgIds: string[] = [];
    for (const r of rows) {
      for (const e of parseRecentMessageIds(r.recent_message_ids)) {
        msgIds.push(e.id);
      }
    }
    if (msgIds.length === 0) return null;
    return batchFetchMessages(spaceDbFor(spaceDid), msgIds, hidden);
  });
  for (const fetched of fetchedBySpace) {
    if (fetched === null) continue;
    for (const [k, v] of fetched) messagesData.set(k, v);
  }

  // Step 6: derive unread counts. The watermark lives in the read-state DB
  // (`read_positions`); the messages it is counted against live in the room's
  // per-space DB, so the count is resolved per space — one range count per
  // room, and no scan of the room's messages.
  const roomIds = pageRows.map((r) => r.room_id);
  const unreadCounts = await batchFetchUnreadCounts(mainDb, bySpace, userDid, roomIds);

  // Step 7: assemble feed items.
  const feed: ActivityFeedItem[] = pageRows.map((r) => {
    const messageIds = parseRecentMessageIds(r.recent_message_ids);
    const messages: ActivityMessage[] = [];
    for (const e of messageIds) {
      const msg = messagesData.get(e.id);
      if (msg) messages.push(msg);
    }

    const item: ActivityFeedItem = {
      threadId: r.room_id,
      spaceId: r.space_id,
      lastActivityAt: new Date(r.last_activity_at).toISOString(),
      activityType: "message",
      messages,
      unreadCount: unreadCounts.get(r.room_id) ?? 0,
    };

    if (r.room_name != null) item.threadName = r.room_name;
    if (r.space_name != null) item.spaceName = r.space_name;
    if (r.space_avatar != null) item.spaceAvatar = r.space_avatar;
    if (r.parent_channel_id != null) {
      item.channelId = r.parent_channel_id;
      if (r.parent_channel_name != null) item.channelName = r.parent_channel_name;
    }

    return item;
  });

  // Step 8: hydrate media + link embeds + reactions for the LATEST message of
  // each feed item only (index 0 of `recent_message_ids`, newest-first).
  // These reads hit per-space tables, so fan out by space.
  const lastMsgIdsBySpace = new Map<string, string[]>();
  for (const it of feed) {
    const last = it.messages[0]?.id;
    if (last == null) continue;
    let arr = lastMsgIdsBySpace.get(it.spaceId);
    if (!arr) {
      arr = [];
      lastMsgIdsBySpace.set(it.spaceId, arr);
    }
    arr.push(last);
  }
  const attachmentsByMsg = new Map<string, Array<AttachmentDto>>();
  const pageLinkUrls = new Set<string>();
  const reactionsByMsg = new Map<string, Array<{ emoji: string; count: number; myReactionId?: string }>>();
  const hydrated = await mapBounded([...lastMsgIdsBySpace], SPACE_FANOUT_CONCURRENCY, async ([spaceDid, lastMsgIds]) => {
    const spaceDb = spaceDbFor(spaceDid);
    const embeds = await batchFetchEmbeds(spaceDb, lastMsgIds);
    const reactions = await batchFetchReactions(spaceDb, lastMsgIds, userDid);
    return { embeds, reactions };
  });
  for (const { embeds, reactions } of hydrated) {
    for (const [k, v] of embeds.attachmentsByMsg) attachmentsByMsg.set(k, v);
    for (const u of embeds.linkUrls) pageLinkUrls.add(u);
    for (const [k, v] of reactions) reactionsByMsg.set(k, v);
  }

  // The enrichment is global and keyed by URL, so one lookup covers every
  // space on the page — resolved once here rather than per space, and after
  // the per-space loop has collected the full URL set.
  const linkEmbedDataMap = new Map<string, Record<string, unknown> | null>();
  if (pageLinkUrls.size > 0 && linkEmbedDb) {
    const stored = await selectEmbedJsonByUrl(linkEmbedDb, [...pageLinkUrls]);
    for (const [url, embedJson] of stored) {
      linkEmbedDataMap.set(
        url,
        embedJson ? (JSON.parse(embedJson) as Record<string, unknown>) : null,
      );
    }
  }

  for (const it of feed) {
    const last = it.messages[0];
    if (!last) continue;
    const attachments = attachmentsByMsg.get(last.id);
    if (attachments && attachments.length > 0) {
      // Link entries take their enrichment from the global store, which the
      // per-space query above cannot reach — applied here, where both halves
      // are in hand. The store is keyed by the canonical url; the entry's own
      // `url` keeps Roomy's `?message=<id>` encoding, which is what the
      // client's dismiss/re-add toggle matches on.
      const resolved = attachments.map((a): AttachmentDto => {
        if (a.$type !== "space.roomy.attachment.link.v0") return a;
        const embed = linkEmbedDataMap.get(canonicalUrl(a.url));
        return embed != null ? { $type: a.$type, url: a.url, embed } : a;
      });
      const { media, linkEmbeds } = deriveAttachmentViews(resolved);
      last.attachments = resolved;
      if (media.length > 0) last.media = media;
      if (linkEmbeds.length > 0) last.linkEmbeds = linkEmbeds;
    }
    const reactions = reactionsByMsg.get(last.id);
    if (reactions && reactions.length > 0) last.reactions = reactions;
  }

  // Step 9: compute the next cursor.
  let cursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1]!;
    cursor = `${last.last_activity_at}::${last.room_id}`;
  }

  return { feed, cursor, spaceCount: spaceDids.length };
}

// ─── Batch fetch helpers ─────────────────────────────────────────────────
interface MessageRow {
  id: string;
  mime_type: string | null;
  data: Buffer | Uint8Array | null;
  author_did: string | null;
  author_name: string | null;
  author_handle: string | null;
  author_avatar: string | null;
  timestamp: number | null;
}

/**
 * Batch-fetch full message data for a set of message IDs.
 * Returns a Map<messageId, ActivityMessage>.
 */
async function batchFetchMessages(
  db: DbLike,
  messageIds: string[],
  /**
   * The author DIDs hidden from the viewer, from `hiddenBy`. A row whose
   * author is in this set is dropped before `hydrateProfiles` runs, so a
   * blocked author's name and avatar never enter the process.
   */
  hidden: ReadonlySet<string>,
): Promise<Map<string, ActivityMessage>> {
  const result = new Map<string, ActivityMessage>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => "?").join(",");
  const rows = await db
    .query(
      `select
         e.id as id,
         cc.mime_type as mime_type,
         cc.data as data,
         coalesce(author_e.tail, '') as author_did,
         author_info.name as author_name,
         author_info.avatar as author_avatar,
         author_user.handle as author_handle,
         cc.timestamp as timestamp
       from entities e
       left join comp_content cc on cc.entity = e.id
       left join edges author_e
         on author_e.head = e.id and author_e.label = 'author'
       left join comp_info author_info on author_info.entity = author_e.tail
       left join comp_user author_user on author_user.did = author_e.tail
       where e.id in (${placeholders})`,
    )
    .all<MessageRow>(messageIds)
  for (const r of rows) {
    // A hidden author's message is dropped before hydration. The feed shows
    // previews with no indicator and no reveal, so it is simply absent rather
    // than tombstoned. Each message's `author` object IS the feed item's
    // participant, so dropping the message drops the participant with it.
    if (hidden.has(r.author_did ?? "")) continue;
    result.set(r.id, {
      id: r.id,
      content: decodeContent(r.mime_type, r.data),
      ...(r.mime_type != null ? { mimeType: r.mime_type } : {}),
      author: {
        did: r.author_did ?? "",
        ...(r.author_name != null ? { name: r.author_name } : {}),
        ...(r.author_handle != null ? { handle: r.author_handle } : {}),
        ...(r.author_avatar != null ? { avatar: r.author_avatar } : {}),
      },
      ...(r.timestamp != null ? { timestamp: new Date(r.timestamp).toISOString() } : {}),
    });
  }

  // Resolve author profiles from the global store (with an in-memory cache).
  // A message author's profile entity lives in their own stream, not this
  // space's stream, so the per-space comp_user/comp_info join above is null
  // for cross-stream authors. The global `profiles` table is authoritative;
  // the per-space value (if any) acts as a fallback.
  const authors = [...result.values()].map((m) => m.author);
  await hydrateProfiles(
    authors,
    (a) => a.did,
    (a, p) => {
      if (p.name != null) a.name = p.name;
      if (p.handle != null) a.handle = p.handle;
      if (p.avatar != null) a.avatar = p.avatar;
    },
  );

  return result;
}

/**
 * Derive unread counts for a page of feed rooms.
 * Returns a Map<roomId, unreadCount>.
 *
 * The watermarks come from one read-state query; each room's count is then a
 * range count against the per-space DB that holds its messages, batched per
 * space. `rowsBySpace` is the page's own grouping (room id → its space), so
 * the fan-out matches the message fetch above rather than re-resolving each
 * room's owning space.
 */
async function batchFetchUnreadCounts(
  readStateDb: DbLike,
  rowsBySpace: ReadonlyMap<string, ActivityItemRow[]>,
  userDid: string,
  roomIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (roomIds.length === 0) return result;

  const ph = roomIds.map(() => "?").join(",");
  const rows = await readStateDb
    .query(
      `select room_id, seen_up_to
         from read_positions
        where user_did = ? and room_id in (${ph})`,
    )
    .all<{ room_id: string; seen_up_to: string }>(userDid, ...roomIds);
  const watermarks = new Map(rows.map((r) => [r.room_id, r.seen_up_to]));

  // The feed renders each room's unread count for this caller, so it counts
  // what this caller can see: a hidden author's messages are not waiting to be
  // read (`deriveUnreadCounts`).
  const hidden = await hiddenBy(userDid);

  // One range count per space, concurrent and bounded like the other
  // per-space passes in this query.
  const perSpace = await mapBounded([...rowsBySpace], SPACE_FANOUT_CONCURRENCY, async ([spaceDid, spaceRows]) => {
    const spaceRoomIds = spaceRows
      .map((r) => r.room_id)
      .filter((id) => watermarks.has(id));
    if (spaceRoomIds.length === 0) return null;
    const counts = await deriveUnreadCounts(
      spaceDbFor(spaceDid),
      spaceRoomIds.map((roomId) => ({
        roomId,
        seenUpTo: watermarks.get(roomId)!,
        hidden,
      })),
    );
    return { spaceRoomIds, counts };
  });
  for (const entry of perSpace) {
    if (entry === null) continue;
    entry.spaceRoomIds.forEach((roomId, i) => result.set(roomId, entry.counts[i] ?? 0));
  }

  return result;
}

// ─── Embed hydration (latest message only) ────────────────────────────────

/**
 * No enrichment known yet: the link variant of an attachment is built here
 * from the per-space row alone, and the caller fills its `embed` from the
 * global store, the only place that holds one.
 */
const NO_EMBED_DATA: ReadonlyMap<string, Record<string, unknown> | null> = new Map();

/**
 * Batch-fetch the attachments of a set of message IDs.
 *
 * Mirrors the embed query in `selectMessages.ts` — a single UNION ALL across
 * comp_embed_image / _video / _file / _link / _tile joined to `entities`
 * (whose `room` points at the owning message), each branch tagging its rows
 * with the kind they came from. That tag becomes each entry's `$type`, exactly
 * as it does on the message read path, so both surfaces hand out the same
 * attachment list.
 *
 * The per-space side supplies the link and media rows; the enrichment for the
 * link URLs comes from the global `link_embeds` store, so the URLs are returned
 * for the caller to resolve in one lookup across every space on the page.
 */
async function batchFetchEmbeds(
  db: DbLike,
  messageIds: string[],
): Promise<{
  attachmentsByMsg: Map<string, Array<AttachmentDto>>;
  linkUrls: Set<string>;
}> {
  const attachmentsByMsg = new Map<string, Array<AttachmentDto>>();
  const linkUrls = new Set<string>();
  if (messageIds.length === 0) return { attachmentsByMsg, linkUrls };

  const idPh = messageIds.map(() => "?").join(",");
  const embedRows = await db
    .query(
      `select e.room as message_id, 'image' as kind, ei.entity as url,
              ei.mime_type as mime_type, ei.alt as alt,
              ei.width as width, ei.height as height,
              ei.blurhash as blurhash, ei.size as size,
              null as length, null as name, null as data
         from comp_embed_image ei
         join entities e on e.id = ei.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, 'video' as kind, ev.entity as url,
              ev.mime_type as mime_type, ev.alt as alt,
              ev.width as width, ev.height as height,
              ev.blurhash as blurhash, ev.size as size,
              ev.length as length, null as name, null as data
         from comp_embed_video ev
         join entities e on e.id = ev.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, 'file' as kind, ef.entity as url,
              ef.mime_type as mime_type, null as alt,
              null as width, null as height,
              null as blurhash, ef.size as size,
              null as length, ef.name as name, null as data
         from comp_embed_file ef
         join entities e on e.id = ef.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, 'link' as kind, el.entity as url,
              'text/uri-list' as mime_type, null as alt,
              null as width, null as height,
              null as blurhash, null as size,
              null as length, null as name, null as data
         from comp_embed_link el
         join entities e on e.id = el.entity
        where e.room in (${idPh})
          and el.show_preview = 1
       union all
       select e.room as message_id, 'tile' as kind, et.tile_uri as url,
              null as mime_type, null as alt,
              null as width, null as height,
              null as blurhash, null as size,
              null as length, null as name, et.data as data
         from comp_embed_tile et
         join entities e on e.id = et.entity
        where e.room in (${idPh})`,
    )
    // Each UNION branch has its own `where ... in (${idPh})` — bind ids
    // once per branch (5× total). bun:sqlite has no positional reuse here.
    .all<EmbedRow>([...messageIds, ...messageIds, ...messageIds, ...messageIds, ...messageIds]);

  for (const e of embedRows) {
    let arr = attachmentsByMsg.get(e.message_id);
    if (!arr) {
      arr = [];
      attachmentsByMsg.set(e.message_id, arr);
    }
    // The link variant's `embed` is filled from the global store by the
    // caller, which is the only place that holds it.
    arr.push(attachmentFromEmbedRow(e, NO_EMBED_DATA));
    if (e.kind === "link") linkUrls.add(canonicalUrl(e.url));
  }

  return { attachmentsByMsg, linkUrls };
}

interface ReactionRow {
  entity: string;
  reaction: string;
  user: string;
  reaction_id: string;
}

/**
 * Batch-fetch reactions for a set of message IDs, grouped into
 * `{ emoji, dids[], myReactionId? }` buckets per message. `myReactionId` is
 * only set for the viewer's own reaction (so the client can render/highlight
 * it). Mirrors the reaction assembly in `selectMessages.ts`.
 */
async function batchFetchReactions(
  db: DbLike,
  messageIds: string[],
  viewerDid?: string,
): Promise<Map<string, Array<{ emoji: string; count: number; myReactionId?: string }>>> {
  const result = new Map<string, Array<{ emoji: string; count: number; myReactionId?: string }>>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => "?").join(",");
  const rows = await db
    .query(
      `select entity, reaction, user, reaction_id from comp_reaction
        where entity in (${placeholders})`,
    )
    .all<ReactionRow>([...messageIds]);

  // Per-message: emoji -> set of reactor DIDs.
  const reactionMap = new Map<string, Map<string, Set<string>>>();
  // Per-message: emoji -> reaction_id of the viewer's own reaction.
  const viewerReactionId = new Map<string, Map<string, string>>();

  for (const r of rows) {
    let perMsg = reactionMap.get(r.entity);
    if (!perMsg) {
      perMsg = new Map();
      reactionMap.set(r.entity, perMsg);
    }
    let dids = perMsg.get(r.reaction);
    if (!dids) {
      dids = new Set();
      perMsg.set(r.reaction, dids);
    }
    dids.add(r.user);

    if (viewerDid && r.user === viewerDid) {
      let perMsgViewer = viewerReactionId.get(r.entity);
      if (!perMsgViewer) {
        perMsgViewer = new Map();
        viewerReactionId.set(r.entity, perMsgViewer);
      }
      perMsgViewer.set(r.reaction, r.reaction_id);
    }
  }

  for (const [entity, perMsg] of reactionMap.entries()) {
    const perMsgViewer = viewerReactionId.get(entity);
    const arr: Array<{ emoji: string; count: number; myReactionId?: string }> = [];
    for (const [emoji, dids] of perMsg.entries()) {
      const myReactionId = perMsgViewer?.get(emoji);
      arr.push({
        emoji,
        count: dids.size,
        ...(myReactionId != null ? { myReactionId } : {}),
      });
    }
    result.set(entity, arr);
  }

  return result;
}