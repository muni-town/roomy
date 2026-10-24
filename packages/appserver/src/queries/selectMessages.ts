/**
 * Message selection helper used by `room.getMessages` and `message.getMessage`.
 *
 * Returns fully denormalised message objects with all joins resolved
 * server-side: author, content, `attachments` (one entry per attachment, each
 * carrying its `$type`), and the per-kind views derived from that list —
 * `replyTo`, `forwardedFrom`, `media`, `linkEmbeds`.
 *
 * A forwarded message is the forwarder's own message; the original is fully
 * denormalised (author, content, timestamp, reactions, media, link embeds,
 * and its own `forwardedFrom` chain for nested forwards) and nested under
 * `forwardedFrom.message` so clients render forwards with no extra fetches.
 *
 * A message whose author is hidden from the viewer by a block — in either
 * direction — comes back as a **tombstone**: id, `sort_idx`, timestamp,
 * `authorDid` and `blocked: true`, with an empty body and no attachments. The
 * row keeps its place in the page, so the page stays full, `nextCursor` stays
 * correct and the client has somewhere to draw the indicator. See
 * `roomPageSql` for why this is a column rather than a `where` clause.
 *
 * Strategy: 1 query for the message rows + singleton-edge joins (author,
 * reply, forward), then 3 small batch queries (reactions, image+video+
 * file+link embeds, link embed data) keyed on the page's non-tombstoned IDs,
 * plus one recursive `selectMessages` batch for the forwarded originals.
 * Constant query count, regardless of page size.
 *
 * The caller is responsible for authorisation — this helper does not check
 * read access.
 */

import type { DbLike } from "../db/types.ts";
import { selectEmbedJsonByUrl } from "../embed/store.ts";
import { canonicalUrl } from "./links.ts";
import { decodeContent } from "../db/content.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import { hydrateProfiles, resolveProfiles } from "./profileStore.ts";
import type { UserDid as UserDidT } from "@roomy-space/sdk";
import { hiddenBy } from "./userBlocks.ts";
import { decodeTime } from "ulidx";

export interface ReactionDto {
  emoji: string;
  count: number;
  /** reaction_id of the viewer's own reaction for this emoji; absent when not reacted. */
  myReactionId?: string;
}

export interface LinkEmbedDto {
  url: string;
  /** Enriched embed data (EmbedV1 JSON), absent when enrichment hasn't completed or had no data. */
  embed?: Record<string, unknown>;
}

export interface MediaDto {
  url: string;
  type: string;
  alt?: string;
  width?: number;
  height?: number;
  blurhash?: string;
  size?: number;
  length?: number;
  name?: string;
}

/**
 * One entry per attachment on a message, discriminated by `$type`.
 *
 * This is the whole of a message's attachments; `media`, `linkEmbeds`,
 * `replyTo` and `forwardedFrom` on `MessageDto` are derived views over it,
 * kept while the renderers built against them migrate. A renderer switches on
 * `$type` here instead of being handed a fifth parallel field.
 *
 * The kind set is the projection's: `space.roomy.attachment.comment.v0` is
 * materialised into `comp_comment` but read by no query, so it never reaches a
 * client and has no variant. `Reply` carries no `message` — a reply renders as
 * a context line that fetches on demand, unlike a forward, which is
 * denormalised here because its embed renders the original inline.
 */
export type AttachmentDto =
  | {
      $type: "space.roomy.attachment.reply.v0";
      messageId: string;
    }
  | {
      $type: "space.roomy.attachment.forward.v0";
      messageId: string;
      roomId: string;
      name: string;
      message?: MessageDto;
    }
  | {
      $type: "space.roomy.attachment.image.v0";
      url: string;
      type: string;
      alt?: string;
      width?: number;
      height?: number;
      blurhash?: string;
      size?: number;
    }
  | {
      $type: "space.roomy.attachment.video.v0";
      url: string;
      type: string;
      alt?: string;
      width?: number;
      height?: number;
      length?: number;
      blurhash?: string;
      size?: number;
    }
  | {
      $type: "space.roomy.attachment.file.v0";
      url: string;
      type: string;
      name?: string;
      size?: number;
    }
  | {
      $type: "space.roomy.attachment.link.v0";
      url: string;
      embed?: Record<string, unknown>;
    };

/** The four embed component tables a row can come from, tagged in the UNION. */
export type EmbedKind = "image" | "video" | "file" | "link";

/** An embed row as the batch query returns it: one row per attachment. */
export interface EmbedRow {
  message_id: string;
  kind: EmbedKind;
  url: string;
  mime_type: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  size: number | null;
  length: number | null;
  name: string | null;
}

/**
 * Project one embed row into the attachment list entry for its kind.
 *
 * The row's `kind` is which component table it came from, and it is what
 * supplies the entry's `$type` — the tag a renderer dispatches on and the one
 * thing the flat `media` shape could not carry. The link variant takes its
 * enriched metadata from the global store, which is keyed by the CANONICAL
 * URL, while an attachment's entity id carries Roomy's `?message=<id>`
 * encoding; the entry's `url` stays that entity id, since the client's
 * dismiss/re-add toggle matches on it.
 */
export function attachmentFromEmbedRow(
  row: EmbedRow,
  linkEmbedData: ReadonlyMap<string, Record<string, unknown> | null>,
): AttachmentDto {
  switch (row.kind) {
    case "image":
      return stripNulls({
        $type: "space.roomy.attachment.image.v0",
        url: row.url,
        type: row.mime_type,
        alt: row.alt ?? undefined,
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        blurhash: row.blurhash ?? undefined,
        size: row.size ?? undefined,
      }) as AttachmentDto;
    case "video":
      return stripNulls({
        $type: "space.roomy.attachment.video.v0",
        url: row.url,
        type: row.mime_type,
        alt: row.alt ?? undefined,
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        length: row.length ?? undefined,
        blurhash: row.blurhash ?? undefined,
        size: row.size ?? undefined,
      }) as AttachmentDto;
    case "file":
      return stripNulls({
        $type: "space.roomy.attachment.file.v0",
        url: row.url,
        type: row.mime_type,
        name: row.name ?? undefined,
        size: row.size ?? undefined,
      }) as AttachmentDto;
    case "link": {
      const embed = linkEmbedData.get(canonicalUrl(row.url));
      return {
        $type: "space.roomy.attachment.link.v0",
        url: row.url,
        ...(embed != null ? { embed } : {}),
      };
    }
  }
}

/**
 * Derive the per-kind views a renderer built against `media` / `linkEmbeds`
 * reads, from one message's attachment list.
 *
 * This is the single rule behind both fields: `media` is the image, video and
 * file entries in kind order followed by the links as `text/uri-list` rows
 * (which the media renderers filter out by MIME type — links have always
 * travelled there), and `linkEmbeds` is the link entries with their enriched
 * metadata. Both surfaces that hand a client attachments use this, so a
 * derived view cannot drift from the list it claims to be a view of.
 */
export function deriveAttachmentViews(attachments: ReadonlyArray<AttachmentDto>): {
  media: Array<MediaDto>;
  linkEmbeds: Array<LinkEmbedDto>;
} {
  const media: Array<MediaDto> = [];
  const linkEmbeds: Array<LinkEmbedDto> = [];
  for (const a of attachments) {
    if (a.$type === "space.roomy.attachment.link.v0") {
      media.push(stripNulls({
        url: a.url,
        type: "text/uri-list",
      }) as MediaDto);
      linkEmbeds.push({
        url: a.url,
        ...(a.embed != null ? { embed: a.embed } : {}),
      });
    } else if (
      a.$type === "space.roomy.attachment.image.v0" ||
      a.$type === "space.roomy.attachment.video.v0"
    ) {
      media.push(stripNulls({
        url: a.url,
        type: a.type,
        alt: a.alt,
        width: a.width,
        height: a.height,
        blurhash: a.blurhash,
        size: a.size,
        length: a.$type === "space.roomy.attachment.video.v0" ? a.length : undefined,
      }) as MediaDto);
    } else if (a.$type === "space.roomy.attachment.file.v0") {
      media.push(stripNulls({
        url: a.url,
        type: a.type,
        size: a.size,
        name: a.name,
      }) as MediaDto);
    }
  }
  return { media, linkEmbeds };
}

export interface MessageDto {
  id: string;
  /** Sort index for timeline ordering. ULID based on canonical timestamp. */
  sort_idx?: string;
  content: string;
  /**
   * MIME type of the content blob. `text/markdown` for legacy messages,
   * `application/vnd.roomy.richtext+json` for blocks+facets messages.
   * Clients branch rendering on this.
   */
  mimeType?: string;
  authorDid: string;
  authorName: string;
  authorHandle?: string;
  authorAvatar?: string;
  /**
   * True for system messages — messages authored by the space itself (e.g.
   * "X joined the space", "X created [thread]"). The author line is not
   * meaningful for these; clients hide the author identity and rely on the
   * message body.
   */
  system?: boolean;
  timestamp: string;
  /**
   * Present only when the message has been edited: an identifier for the write
   * that last set its content (from `comp_content.last_edit`). Absent for a
   * message that has never been edited — the projection stamps `last_edit`
   * with the message's own id in that case, so both cases are told apart by
   * comparing `last_edit` against the message id rather than by exposing a
   * field that is always set. Clients render an "edited" affordance when it is
   * present; the value is not a timestamp.
   */
  lastEdit?: string;
  /**
   * Every attachment on the message, one entry per row, discriminated by
   * `$type`. The single list a renderer dispatches over; the derived fields
   * below are views of it.
   */
  attachments: Array<AttachmentDto>;
  /** Derived from `attachments` (the reply variant's `messageId`). */
  replyTo?: string;
  /** Derived from `attachments` (the forward variant, denormalised). */
  forwardedFrom?: {
    messageId: string;
    name: string;
    roomId: string;
    /** Fully denormalised original message (its own forwardedFrom chain
     *  included for nested forwards). Absent when the original couldn't be
     *  resolved (deleted, not-yet-materialised, or cross-space). */
    message?: MessageDto;
  };
  reactions: Array<ReactionDto>;
  /**
   * Derived from `attachments`: the image, video and file variants plus the
   * link variants as `text/uri-list` entries, in that kind order. Links have
   * always travelled here and the media renderers filter them out by MIME
   * type, so the derived view keeps that shape.
   */
  media: Array<MediaDto>;
  /** Derived from `attachments`: the link variants, with enriched metadata. */
  linkEmbeds: Array<LinkEmbedDto>;
  /**
   * The message's author is hidden from the viewer by a block, in either
   * direction (§ user blocks). A hidden author's row is redacted to a
   * tombstone — identity and ordering kept, body and attachments gone — and
   * this flag is what tells that row apart from a genuinely empty message.
   *
   * `message.getMessage` also sets it on the one row a space admin who placed
   * the block themselves fetches in full (§3.6): the body is present, and the
   * viewer still needs to see that the author is hidden.
   */
  blocked?: boolean;
}

/**
 * The row a hidden author's message becomes for a viewer who must not read it:
 * identity and ordering kept — they are what the indicator, the deep link and
 * the page's position rest on — and everything else gone.
 *
 * `authorDid` stays, and names who is hidden. It is the blocked identity, which
 * the room's own membership already discloses; what a block withholds is the
 * body, the attachments and the display profile.
 *
 * Exported because the live path builds the same row: a `#messageDiff` frame and
 * the page fetched after it must agree, or a message would render as a body over
 * the socket and as an indicator on the next read.
 */
export function blockedTombstone(row: {
  id: string;
  sort_idx?: string | null;
  authorDid: string;
  timestamp: string;
}): MessageDto {
  return stripNulls({
    id: row.id,
    sort_idx: row.sort_idx,
    content: "",
    authorDid: row.authorDid,
    authorName: "",
    blocked: true,
    timestamp: row.timestamp,
    attachments: [],
    reactions: [],
    media: [],
    linkEmbeds: [],
  }) as MessageDto;
}

export type SelectScope =
  | { kind: "room"; roomId: string; limit: number; cursor: string | null }
  | {
      kind: "ids";
      ids: string[];
      /**
       * Skip the global-profile hydration pass (and its on-demand Bluesky /
       * HappyView fetch). Set by internal callers that read message rows for
       * their own purposes — the invalidation router, which only needs the
       * fields that drive a diff — rather than to render a message to a
       * client. Without this, a single live event drags a profile fetch onto
       * the write path (see `hydrateProfiles` below).
       */
      skipProfileHydration?: boolean;
      /**
       * Internal: ids already on the current forward-resolution chain. A
       * forward never re-resolves an id already seen, bounding pathological
       * cycles (A forwards B, B forwards A) to one pass instead of
       * recursing forever.
       */
      forwardChain?: string[];
    };

interface BaseRow {
  id: string;
  stream_id: string | null;
  sort_idx: string | null;
  room: string | null;
  mime_type: string | null;
  data: Buffer | Uint8Array | null;
  timestamp: number | null;
  last_edit: string | null;
  author_did: string | null;
  author_name: string | null;
  author_handle: string | null;
  author_avatar: string | null;
  reply_to: string | null;
  forward_target: string | null;
  forward_target_room: string | null;
  forward_target_room_name: string | null;
  /** 1 when the row's author is hidden from the viewer (§ user blocks). */
  blocked: number;
}

/**
 * The timeline key a cursor names: the message's `sort_idx`, or its id when the
 * message was never sorted (system messages such as `joinSpace` and
 * `createRoomLink` materialise without one).
 *
 * A client pages backward by sending the id of the oldest message it holds —
 * ids are what a message object carries, so the cursor is an id and the key is
 * derived here rather than being carried on the wire. A cursor naming no
 * materialised row falls back to the cursor itself, which is the key such a
 * message would have had; an unresolvable cursor pages as if it were a sorted
 * key instead of silently restarting from the newest page.
 */
async function resolveCursorKey(db: DbLike, cursorId: string): Promise<string> {
  const row = await db
    .query("select coalesce(sort_idx, id) as key from entities where id = ?")
    .get<{ key: string }>(cursorId);
  return row?.key ?? cursorId;
}

/**
 * The room timeline's page query.
 *
 * Order and filter on the SAME key. The cursor a client sends is a message
 * id, but the page is ordered by the timeline key `coalesce(sort_idx, id)`:
 * `sort_idx` is the message's ordering key (the receipt time this server
 * recorded for the event, or a bridge-supplied `timestampOverride`) while the
 * id is the minting ULID, so the two orders run opposite each other for
 * bridged backfill and an id-only filter drops and repeats rows. The cursor
 * is resolved to its own timeline key first, then compared as a keyset with
 * `id` as the tie-break — without the tie-break a page boundary inside a run
 * of equal keys is unstable.
 *
 * `hasCursor` interpolates the keyset predicate and the `limit` is inlined,
 * so this needs `idx_entities_room_sort_key (room, coalesce(sort_idx, id),
 * id)` to walk the index and stop after the limit. Ordering by a plain
 * expression without that index falls back to a temp-B-tree sort of every
 * entity in the room, which is catastrophic on a large bridged channel.
 * Exported so `selectMessages.test.ts` can assert the plan on the SQL the
 * read path actually runs, in both the first-page and cursor forms.
 *
 * The hidden-author flag is a column, never a `where` clause. Filtering the
 * page would shrink it after the `limit` while `nextCursor` is still derived
 * from `baseRows.length`, so a page with hidden rows would come back short
 * and a fully hidden page would set no cursor at all — the scrollback below a
 * blocked author would silently truncate. Redaction keeps the row and its
 * position; only its body goes.
 *
 * It is bound as one JSON array (`?2`), not one parameter per DID, so the
 * statement text is stable across viewers and the keyset still walks the
 * index. The index is explicit because the parameter sits in the select list
 * while `?1` is in the `where`: SQLite binds by index, not by position in the
 * text, so a cursor page binds `roomId, hidden, cursorKey, cursor`.
 */
export function roomPageSql(hasCursor: boolean, limit: number): string {
  return `
      select
        e.id as id,
        (case when author_e.tail in (select value from json_each(?2))
              then 1 else 0 end) as blocked,
        e.stream_id as stream_id,
        e.sort_idx as sort_idx,
        e.room as room,
        cc.mime_type as mime_type,
        cc.data as data,
        cc.timestamp as timestamp,
        cc.last_edit as last_edit,
        author_e.tail as author_did,
        author_info.name as author_name,
        author_info.avatar as author_avatar,
        author_user.handle as author_handle,
        reply_e.tail as reply_to,
        forward_e.tail as forward_target,
        forward_target_entity.room as forward_target_room,
        forward_target_room_info.name as forward_target_room_name
      from entities e
      left join comp_content cc on cc.entity = e.id
      left join edges author_e
        on author_e.head = e.id and author_e.label = 'author'
      left join comp_info author_info on author_info.entity = author_e.tail
      left join comp_user author_user on author_user.did = author_e.tail
      left join edges reply_e
        on reply_e.head = e.id and reply_e.label = 'reply'
      left join edges forward_e
        on forward_e.head = e.id and forward_e.label = 'forward'
      left join entities forward_target_entity
        on forward_target_entity.id = forward_e.tail
      left join comp_info forward_target_room_info
        on forward_target_room_info.entity = forward_target_entity.room
      where e.room = ?1
        and (cc.entity is not null or forward_e.tail is not null)
        ${hasCursor
          ? `and (coalesce(e.sort_idx, e.id) < ?3
                  or (coalesce(e.sort_idx, e.id) = ?3 and e.id < ?4))`
          : ""}
      order by coalesce(e.sort_idx, e.id) desc, e.id desc
      limit ${Math.max(1, Math.min(limit, 100))}
    `;
}

export async function selectMessages(
  db: DbLike,
  scope: SelectScope,
  viewerDid?: UserDidT | null,
  /**
   * The global `link_embeds` store to hydrate link cards from. Optional
   * because a per-space handle cannot reach it — the per-space DB and the
   * store are separate databases on separate workers — so a caller that has
   * the global handle passes it, and a caller that does not (a raw test
   * adapter) renders bare links.
   */
  globalDb?: DbLike | null,
  /**
   * The authors hidden from `viewerDid`, already resolved by the caller
   * (§ user blocks). Omitted, it is resolved here from `viewerDid`. An empty
   * array is how `message.getMessage`'s reveal branch asks for one id in full
   * while still resolving the viewer's own reaction (§3.6).
   *
   * Passed down the forward-original recursion so an embedded original is
   * redacted on the same terms as the row that embedded it.
   */
  hidden?: readonly string[],
): Promise<{ messages: MessageDto[]; nextCursor: string | null }> {
  const hiddenAuthors = hidden ?? (viewerDid ? [...(await hiddenBy(viewerDid))] : []);
  // One JSON array bound as one parameter, so the statement text stays stable
  // and every row's flag is computed by the same query.
  const hiddenParam = JSON.stringify(hiddenAuthors);

  // ── Step 1: pull the base rows ────────────────────────────────────────
  let baseRows: BaseRow[];
  if (scope.kind === "room") {
    const cursorKey = scope.cursor ? await resolveCursorKey(db, scope.cursor) : null;
    const stmt = db.query(roomPageSql(cursorKey !== null, scope.limit));
    baseRows = cursorKey !== null
      ? await stmt.all([scope.roomId, hiddenParam, cursorKey, scope.cursor])
      : await stmt.all([scope.roomId, hiddenParam]);
  } else {
    if (scope.ids.length === 0) {
      return { messages: [], nextCursor: null };
    }
    // Explicit indices: the hidden set is `?1` in the select list and the ids
    // follow it, so the bind array is `hidden, ...ids` whatever the text
    // order.
    const placeholders = scope.ids.map((_, i) => `?${i + 2}`).join(",");
    baseRows = await db
      .query(
        `
        select
          e.id as id,
          (case when author_e.tail in (select value from json_each(?1))
                then 1 else 0 end) as blocked,
          e.stream_id as stream_id,
          e.sort_idx as sort_idx,
          e.room as room,
          cc.mime_type as mime_type,
          cc.data as data,
          cc.timestamp as timestamp,
          cc.last_edit as last_edit,
          author_e.tail as author_did,
          author_info.name as author_name,
          author_info.avatar as author_avatar,
          author_user.handle as author_handle,
          reply_e.tail as reply_to,
          forward_e.tail as forward_target,
          forward_target_entity.room as forward_target_room,
          forward_target_room_info.name as forward_target_room_name
        from entities e
        left join comp_content cc on cc.entity = e.id
        left join edges author_e
          on author_e.head = e.id and author_e.label = 'author'
        left join comp_info author_info on author_info.entity = author_e.tail
        left join comp_user author_user on author_user.did = author_e.tail
        left join edges reply_e
          on reply_e.head = e.id and reply_e.label = 'reply'
        left join edges forward_e
          on forward_e.head = e.id and forward_e.label = 'forward'
        left join entities forward_target_entity
          on forward_target_entity.id = forward_e.tail
        left join comp_info forward_target_room_info
          on forward_target_room_info.entity = forward_target_entity.room
        where e.id in (${placeholders})
        `,
      )
      .all([hiddenParam, ...scope.ids]);
  }

  if (baseRows.length === 0) return { messages: [], nextCursor: null };
  // Ordering is kept for every row, tombstones included: the page's length
  // and the cursor derived from it must not move when an author is hidden.

  // ── Step 2: forwarded-original resolution ─────────────────────────────
  // Every forward row (forward-as-embed with own content, or a legacy
  // forward reference with no own content) carries a `forwardedFrom`. The
  // original is fetched as a fully denormalised MessageDto (via
  // selectMessages, so its own forwardedFrom chain, reactions, media and
  // link embeds are all resolved) and embedded in `forwardedFrom.message`.
  // Clients render the embedded original directly — no extra fetches.
  //
  // Substituting the original's content and author into the forward row would
  // make a forward look like the ORIGINAL's message and (with the forwarder's
  // own content present) render the same content twice. A forward is always
  // the forwarder's message, with the original nested under
  // `forwardedFrom.message`.
  //
  // Constant query count: one `selectMessages` batch call per chain level.
  // The chain set bounds pathological cycles (A forwards B, B forwards A):
  // a forward never re-resolves an id already on its chain.
  //
  // The hidden set travels with the recursion: an embedded original is
  // redacted when the ORIGINAL's author is hidden, so a blocked author's words
  // do not survive by being forwarded by somebody else. A blocked row is
  // skipped outright — its tombstone carries no `forwardedFrom` for the
  // original to fill.
  const chain = new Set(scope.kind === "ids" ? (scope.forwardChain ?? []) : []);
  const forwardTargets = baseRows
    .filter(
      (r) =>
        r.blocked !== 1 && r.forward_target && !chain.has(r.forward_target),
    )
    .map((r) => r.forward_target!) as string[];

  const forwardOriginalDto = new Map<string, MessageDto>();
  if (forwardTargets.length > 0) {
    const { messages: originals } = await selectMessages(
      db,
      { kind: "ids", ids: [...new Set(forwardTargets)], forwardChain: [...chain, ...forwardTargets] },
      viewerDid,
      globalDb,
      hiddenAuthors,
    );
    for (const orig of originals) forwardOriginalDto.set(orig.id, orig);
  }

  // ── Step 3: batch-fetch reactions / embeds / link embed data keyed by id ──
  //
  // Tombstoned rows are excluded. The batches are keyed on the page's ids, so
  // a hidden author's reactions, media URLs, alt text and enriched link cards
  // would otherwise be pulled into the process for a row that renders none of
  // them — and into a response that must not carry them. A page whose every
  // row is hidden therefore runs no batch query at all.
  const liveIds = baseRows.filter((r) => r.blocked !== 1).map((r) => r.id);
  const idPh = liveIds.map(() => "?").join(",");

  const reactionRows = liveIds.length === 0
    ? []
    : await db
        .query(
          `select entity, reaction, user, reaction_id from comp_reaction
            where entity in (${idPh})`,
        )
        .all<{ entity: string; reaction: string; user: string; reaction_id: string }>([...liveIds]);

  const embedRows = liveIds.length === 0
    ? []
    : await db
        .query(
      // entities.room = messageId for embed entities; UNION across the four
      // embed component tables. comp_embed_link has no media metadata — fall
      // back to nulls and "text/uri-list" mime type. Image/video share
      // width/height/blurhash/size; video adds length; file adds name.
      //
      // `kind` names which table a row came from, so the one list this feeds
      // can tag each entry with the attachment `$type` it came from. The UNION
      // order (image, video, file, link) is the order both that list and the
      // derived `media` view carry.
      `select e.room as message_id, 'image' as kind, ei.entity as url,
              ei.mime_type as mime_type, ei.alt as alt,
              ei.width as width, ei.height as height,
              ei.blurhash as blurhash, ei.size as size,
              null as length, null as name
         from comp_embed_image ei
         join entities e on e.id = ei.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, 'video' as kind, ev.entity as url,
              ev.mime_type as mime_type, ev.alt as alt,
              ev.width as width, ev.height as height,
              ev.blurhash as blurhash, ev.size as size,
              ev.length as length, null as name
         from comp_embed_video ev
         join entities e on e.id = ev.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, 'file' as kind, ef.entity as url,
              ef.mime_type as mime_type, null as alt,
              null as width, null as height,
              null as blurhash, ef.size as size,
              null as length, ef.name as name
         from comp_embed_file ef
         join entities e on e.id = ef.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, 'link' as kind, el.entity as url,
              'text/uri-list' as mime_type, null as alt,
              null as width, null as height,
              null as blurhash, null as size,
              null as length, null as name
         from comp_embed_link el
         join entities e on e.id = el.entity
          where e.room in (${idPh})
            and el.show_preview = 1`,
      )
      // Each UNION branch has its own `where ... in (${idPh})` — bind ids
      // once per branch (4× total). bun:sqlite has no positional reuse here.
      .all<EmbedRow>([...liveIds, ...liveIds, ...liveIds, ...liveIds]);

  // ── Step 4: assemble ──────────────────────────────────────────────────
  const reactionMap = new Map<string, Map<string, Set<string>>>();
  // Viewer's reaction_id per (message, emoji) for myReactionId.
  const viewerReactionId = new Map<string, Map<string, string>>();
  for (const r of reactionRows) {
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

    // Track the viewer's reaction_id for this (entity, emoji) pair.
    if (viewerDid && r.user === viewerDid) {
      let perMsgViewer = viewerReactionId.get(r.entity);
      if (!perMsgViewer) {
        perMsgViewer = new Map();
        viewerReactionId.set(r.entity, perMsgViewer);
      }
      perMsgViewer.set(r.reaction, r.reaction_id);
    }
  }

  // ── Step 3b: batch-fetch enriched link embed data ────────────────────
  // The enrichment lives in the global store, keyed by URL, so it is fetched
  // from there by the URLs this page holds rather than joined to the
  // per-space rows above — the two are separate DBs, so no statement can span
  // them.
  //
  // The store is keyed by the CANONICAL url, while a link attachment's entity
  // id carries Roomy's `?message=<id>` encoding (see the SDK message
  // materialiser). Look up by canonical; keep the entity id for display, since
  // the client matches its dismiss/re-add toggle against it.
  const linkUrls = new Set<string>();
  for (const e of embedRows) {
    if (e.kind === "link") linkUrls.add(canonicalUrl(e.url));
  }

  const linkEmbedDataMap = new Map<string, Record<string, unknown> | null>();
  if (linkUrls.size > 0 && globalDb) {
    const stored = await selectEmbedJsonByUrl(globalDb, [...linkUrls]);
    for (const [url, embedJson] of stored) {
      linkEmbedDataMap.set(
        url,
        embedJson ? (JSON.parse(embedJson) as Record<string, unknown>) : null,
      );
    }
  }

  // ── Step 3c: the attachment list, and the views derived from it ──────
  // The embed rows are the media/file/link half of a message's attachments;
  // the reply and forward halves are edges, resolved in Step 2 and read off
  // each base row below. Both land in `attachments` in the order the message's
  // own list carried them where that is known, and in kinds order where it is
  // not — an embed row is keyed by URL and has no position of its own.
  //
  // `media` and `linkEmbeds` are built from this same list rather than from
  // the rows, so the derived views cannot drift from the list they claim to be
  // views of.
  const attachmentsMap = new Map<string, Array<AttachmentDto>>();
  for (const e of embedRows) {
    let arr = attachmentsMap.get(e.message_id);
    if (!arr) {
      arr = [];
      attachmentsMap.set(e.message_id, arr);
    }
    arr.push(attachmentFromEmbedRow(e, linkEmbedDataMap));
  }

  const mediaMap = new Map<string, Array<MediaDto>>();
  const linkEmbedsMap = new Map<string, Array<LinkEmbedDto>>();
  for (const [messageId, attachments] of attachmentsMap) {
    const { media, linkEmbeds } = deriveAttachmentViews(attachments);
    mediaMap.set(messageId, media);
    linkEmbedsMap.set(messageId, linkEmbeds);
  }

  const messages: MessageDto[] = baseRows.map((r) => {
    // A forward row keeps its OWN content and author — it is the forwarder's
    // message. The original is nested under `forwardedFrom.message` (see
    // Step 2) for clients to render; it is never substituted into the row.
    const mime = r.mime_type;
    const data = r.data;
    const ts = r.timestamp;
    const authorDid = r.author_did;
    const authorName = r.author_name;
    const authorHandle = r.author_handle;
    const authorAvatar = r.author_avatar;

    // A hidden author's row short-circuits here, before content decoding,
    // before the reaction / media / link maps are consulted, and before
    // `hydrateProfiles` could attach a name and avatar, so a blocked body is
    // never even built.
    if (r.blocked === 1) {
      return blockedTombstone({
        id: r.id,
        sort_idx: r.sort_idx,
        authorDid: authorDid ?? "",
        // Legacy forward-reference rows carry no comp_content, so
        // `cc.timestamp` is NULL; fall back to the forward event's own ULID
        // time, exactly as the ordinary path does.
        timestamp:
          ts != null
            ? new Date(ts).toISOString()
            : r.forward_target != null
              ? new Date(decodeTime(r.id)).toISOString()
              : "",
      });
    }

    const content = decodeContent(mime, data);

    const reactions: Array<ReactionDto> = [];
    const perMsg = reactionMap.get(r.id);
    const perMsgViewer = viewerReactionId.get(r.id);
    if (perMsg) {
      for (const [emoji, dids] of perMsg.entries()) {
        reactions.push(stripNulls({
          emoji,
          count: dids.size,
          myReactionId: perMsgViewer?.get(emoji) ?? null,
        }) as ReactionDto);
      }
    }

    const mediaForMsg = mediaMap.get(r.id) ?? [];
    const linkEmbedsForMsg = linkEmbedsMap.get(r.id) ?? [];

    // The message's one attachment list: the reply and forward edges (this
    // row's own columns) followed by the embed rows, which is the order both
    // the derived `media` view and the pre-change projection carried. The
    // reply and forward variants are addressed by id, not by url, so they
    // cannot collide with an embed row.
    const attachments: Array<AttachmentDto> = [];
    if (r.reply_to != null) {
      attachments.push({
        $type: "space.roomy.attachment.reply.v0",
        messageId: r.reply_to,
      });
    }
    if (r.forward_target != null) {
      const original = forwardOriginalDto.get(r.forward_target);
      attachments.push(stripNulls({
        $type: "space.roomy.attachment.forward.v0",
        messageId: r.forward_target,
        name: r.forward_target_room_name ?? "",
        roomId: r.forward_target_room ?? "",
        message: original ?? null,
      }) as AttachmentDto);
    }
    for (const a of attachmentsMap.get(r.id) ?? []) attachments.push(a);

    return stripNulls({
      id: r.id,
      sort_idx: r.sort_idx,
      content,
      mimeType: mime ?? undefined,
      authorDid: authorDid ?? "",
      authorName: authorName ?? "",
      authorHandle: authorHandle,
      authorAvatar: authorAvatar,
      system:
        authorDid != null && r.stream_id != null && authorDid === r.stream_id
          ? true
          : undefined,
      // Legacy forward-reference rows (forwardMessages.v0) carry no
      // comp_content, so cc.timestamp is NULL. Fall back to the forward
      // event's own ULID time — the entity id IS the forward event's ULID —
      // so the forwarder's timestamp is real (the client renders it in the
      // forward context line; an empty string rendered as "Invalid Date").
      timestamp:
        ts != null
          ? new Date(ts).toISOString()
          : r.forward_target != null
            ? new Date(decodeTime(r.id)).toISOString()
            : "",
      // `last_edit` identifies the write that last set this content: the
      // message's own id on insert, the edit's ordering stamp on every edit
      // (see the message record rule). So "edited" is exactly
      // `last_edit != id` — a plain `last_edit` column would mark every
      // message as edited. Absent (not null) for an unedited message, or when
      // there is no comp_content row at all (legacy forward references).
      lastEdit:
        r.last_edit != null && r.last_edit !== r.id ? r.last_edit : undefined,
      attachments,
      replyTo: r.reply_to,
      forwardedFrom:
        r.forward_target != null
          ? stripNulls({
              messageId: r.forward_target,
              name: r.forward_target_room_name ?? "",
              roomId: r.forward_target_room ?? "",
              message: forwardOriginalDto.get(r.forward_target) ?? null,
            })
          : null,
      reactions,
      media: mediaForMsg,
      linkEmbeds: linkEmbedsForMsg,
    }) as MessageDto;
  });

  // Resolve author profiles from the global store (with an in-memory cache).
  // A message author's profile entity lives in their own stream, not this
  // space's stream, so the per-space comp_user/comp_info join above is null
  // for cross-stream authors. The global `profiles` table is authoritative;
  // the per-space value (if any) acts as a fallback.
  //
  // Internal readers (`skipProfileHydration`) still get the global-store
  // lookup — a local indexed read — but not the on-demand fetch that an
  // unresolved author would otherwise trigger. They ask for message *rows*,
  // not rendered messages; on the write path (the invalidation router) that
  // fetch is a third-party HTTP round-trip inside `sendEvents`, and the
  // client resolves the author's profile from the same global store when it
  // applies the diff.
  // Tombstones are left out: a hidden author's name and avatar must not be
  // attached to the indicator row, and `hydrateProfiles` would overwrite the
  // empty `authorName` the tombstone carries. Nothing is lost by skipping
  // them — the row renders no identity at all.
  await hydrateProfiles(
    messages.filter((m) => m.blocked !== true),
    (m) => m.authorDid,
    (m, p) => {
      if (p.name != null) m.authorName = p.name;
      if (p.handle != null) m.authorHandle = p.handle;
      if (p.avatar != null) m.authorAvatar = p.avatar;
    },
    { allowNetworkFetch: !(scope.kind === "ids" && scope.skipProfileHydration) },
  );

  // System messages are authored by the space and reference a *different*
  // user (the joiner / thread creator) in their body by DID — the SDK
  // materialiser stores the raw DID as the link label deterministically.
  // Resolve those DIDs to the user's current handle/display name here, at
  // read time, so the UI never shows a bare DID and we don't bake a missing
  // or stale handle into the stored message.
  await resolveSystemMessageNames(messages);

  // Sort ascending so callers get oldest → newest (matches spec example).
  // This is the reverse of the SQL page order, and it must agree with it
  // exactly: a page boundary that falls inside a run of equal keys is only
  // stable if both orders break the tie by id.
  messages.sort((a, b) => {
    const byKey = (a.sort_idx ?? a.id).localeCompare(b.sort_idx ?? b.id);
    return byKey !== 0 ? byKey : a.id.localeCompare(b.id);
  });

  // Pagination cursor: only meaningful for room scope.
  let nextCursor: string | null = null;
  if (scope.kind === "room") {
    const limit = Math.max(1, Math.min(scope.limit, 100));
    if (baseRows.length === limit) {
      // Cursor is the smallest id in the page (= first item after sort asc).
      nextCursor = messages[0]?.id ?? null;
    }
  }

  return { messages, nextCursor };
}

/**
 * Resolve display names for users referenced by system messages.
 *
 * A system message is authored by the space and references a *different*
 * user (the joiner / thread creator) in its markdown body as
 * `[@<did>](/user/<did>)`. The materialiser stores the raw DID as the link
 * label deterministically, so resolve it to the user's current display
 * name / handle from the global profile store and rewrite the link label —
 * the UI never shows a bare DID. DIDs we can't resolve are left untouched
 * (the user has no profile anywhere); the label remains a clickable link.
 */
async function resolveSystemMessageNames(messages: MessageDto[]): Promise<void> {
  const systemMessages = messages.filter((m) => m.system);
  if (systemMessages.length === 0) return;

  // Collect every `/user/<did>` reference so we can batch-resolve profiles.
  const userLinkRe = /\[\@[^\]]+\]\(\/user\/([^)]+)\)/g;
  const dids = new Set<string>();
  for (const m of systemMessages) {
    for (const match of m.content.matchAll(userLinkRe)) {
      const raw = match[1];
      if (raw) dids.add(decodeURIComponent(raw));
    }
  }
  if (dids.size === 0) return;

  const profiles = await resolveProfiles([...dids]);
  const labelRe = /\[\@([^\]]+)\]\(\/user\/([^)]+)\)/g;
  for (const m of systemMessages) {
    if (!m.content.includes("/user/")) continue;
    m.content = m.content.replace(
      labelRe,
      (whole: string, label: string, didPath: string) => {
        const did = decodeURIComponent(didPath);
        const p = profiles.get(did);
        // Only rewrite the deterministic DID label (label === DID path); leave
        // any pre-existing baked handle or user-authored content untouched.
        if (!p || label !== didPath) return whole;
        // Treat empty/whitespace names as absent: the Bluesky appview returns
        // displayName:"" for users without one, and "" would win over the
        // handle (and then fail the !rendered guard, bailing to the raw DID).
        const name = p.name?.trim() ? p.name : null;
        const rendered = name ?? (p.handle ? `@${p.handle}` : null);
        if (!rendered) return whole;
        return `[${rendered}]${whole.slice(whole.indexOf("("))}`;
      },
    );
  }
}
