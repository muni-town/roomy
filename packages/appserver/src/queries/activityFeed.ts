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
import { hydrateProfiles } from "./profileStore.ts";
import { selectJoinedSpaceDids } from "./userSpaceMembership.ts";

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

  media?: Array<{ url: string; type: string; alt?: string; width?: number; height?: number; blurhash?: string; size?: number; length?: number; name?: string }>;
  /** Reactions on the message. Only hydrated on the latest message. */
  reactions?: Array<{ emoji: string; count: number; myReactionId?: string }>;
  /** Link embeds with enriched metadata from the embed service. */
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
 * time, which is the best available timestamp for pre-fix data.
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
 * Select the activity feed by fanning out to per-space DBs (Phase 2).
 *
 * `mainDb` is the READ-STATE handle, used ONLY for the read-state unread-count
 * query (read_positions lives in the read-state DB). All other reads go
 * against the per-space DBs, one per joined space.
 */
export async function selectActivityFeed(
  mainDb: DbLike,
  userDid: string,
  scope: ActivityFeedScope,
): Promise<{ feed: ActivityFeedItem[]; cursor: string | null }> {
  // Step 0: determine the set of space DIDs from durable membership intent.
  let spaceDids: string[];
  if (scope.spaceId) {
    spaceDids = [scope.spaceId];
  } else {
    spaceDids = await selectJoinedSpaceDids(mainDb, userDid as UserDid);
  }

  if (spaceDids.length === 0) return { feed: [], cursor: null };

  // Step 1: fan out to per-space DBs, fetching a page of rows per space
  // (newest first) so we can merge and paginate globally.
  const allRows: ActivityItemRow[] = [];
  for (const spaceDid of spaceDids) {
    const spaceDb = openSpaceDb(spaceDid);
    const rows = await spaceDb
      .query(
        `select ${ACTIVITY_ITEM_COLUMNS}
         from activity_item ai
         left join comp_room cr on cr.entity = ai.room_id
         where ai.space_id = ? and ${NOT_DELETED}
         order by ai.last_activity_at desc, ai.room_id desc
         limit ?`,
      )
      .all<ActivityItemRow>([spaceDid, scope.limit + 1]);
    allRows.push(...rows);
  }

  if (allRows.length === 0) return { feed: [], cursor: null };

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
  if (pageRows.length === 0) return { feed: [], cursor: null };

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
  for (const [spaceDid, rows] of bySpace) {
    const msgIds: string[] = [];
    for (const r of rows) {
      for (const e of parseRecentMessageIds(r.recent_message_ids)) {
        msgIds.push(e.id);
      }
    }
    if (msgIds.length === 0) continue;
    const spaceDb = openSpaceDb(spaceDid);
    const fetched = await batchFetchMessages(spaceDb, msgIds);
    for (const [k, v] of fetched) messagesData.set(k, v);
  }

  // Step 6: fetch unread counts from the MONOLITHIC handle (readstate tables
  // are not split — they live on the monolithic DB).
  const roomIds = pageRows.map((r) => r.room_id);
  const unreadCounts = await batchFetchUnreadCounts(mainDb, userDid, roomIds);

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
  const mediaByMsg = new Map<string, Array<{ url: string; type: string; alt?: string; width?: number; height?: number; blurhash?: string; size?: number; length?: number; name?: string }>>();
  const linkEmbedsByMsg = new Map<string, Array<{ url: string; embed?: Record<string, unknown> | null }>>();
  const reactionsByMsg = new Map<string, Array<{ emoji: string; count: number; myReactionId?: string }>>();
  for (const [spaceDid, lastMsgIds] of lastMsgIdsBySpace) {
    const spaceDb = openSpaceDb(spaceDid);
    const { mediaByMsg: m, linkEmbedsByMsg: l } = await batchFetchEmbeds(spaceDb, lastMsgIds);
    for (const [k, v] of m) mediaByMsg.set(k, v);
    for (const [k, v] of l) linkEmbedsByMsg.set(k, v);
    const rxn = await batchFetchReactions(spaceDb, lastMsgIds, userDid);
    for (const [k, v] of rxn) reactionsByMsg.set(k, v);
  }
  for (const it of feed) {
    const last = it.messages[0];
    if (!last) continue;
    const media = mediaByMsg.get(last.id);
    if (media && media.length > 0) last.media = media;
    const linkEmbeds = linkEmbedsByMsg.get(last.id);
    if (linkEmbeds && linkEmbeds.length > 0) last.linkEmbeds = linkEmbeds as Array<{ url: string; embed?: Record<string, unknown> }>;
    const reactions = reactionsByMsg.get(last.id);
    if (reactions && reactions.length > 0) last.reactions = reactions;
  }

  // Step 9: compute the next cursor.
  let cursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1]!;
    cursor = `${last.last_activity_at}::${last.room_id}`;
  }

  return { feed, cursor };
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
 * Batch-fetch unread counts for a set of room IDs.
 * Returns a Map<roomId, unreadCount>.
 *
 * Uses a single batched query (WHERE IN) rather than N individual
 * prepared statements. The read-state DB is a separate database, so the
 * query targets `read_positions` directly.
 */
async function batchFetchUnreadCounts(
  db: DbLike,
  userDid: string,
  roomIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (roomIds.length === 0) return result;

  const placeholders = roomIds.map(() => "?").join(",");
  const rows = await db
    .query(
      `select room_id, unread_count
         from read_positions
        where user_did = ? and room_id in (${placeholders})`,
    )
    .all<{room_id: string; unread_count: number}>([userDid, ...roomIds]);

  for (const row of rows) {
    result.set(row.room_id, row.unread_count);
  }

  return result;
}

// ─── Embed hydration (latest message only) ────────────────────────────────

interface EmbedRow {
  message_id: string;
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
 * Batch-fetch media attachments + link embeds for a set of message IDs.
 *
 * Mirrors the embed query in `selectMessages.ts`: a single UNION ALL across
 * comp_embed_image / _video / _file / _link joined to `entities` (whose `room`
 * points at the owning message), then a follow-up query for cached link-embed
 * enrichment data. Returns two maps keyed by message ID.
 */
async function batchFetchEmbeds(
  db: DbLike,
  messageIds: string[],
): Promise<{
  mediaByMsg: Map<string, Array<{ url: string; type: string; alt?: string; width?: number; height?: number; blurhash?: string; size?: number; length?: number; name?: string }>>;
  linkEmbedsByMsg: Map<string, Array<{ url: string; embed?: Record<string, unknown> | null }>>;
}> {
  const mediaByMsg = new Map<string, Array<{ url: string; type: string; alt?: string; width?: number; height?: number; blurhash?: string; size?: number; length?: number; name?: string }>>();
  const linkEmbedsByMsg = new Map<string, Array<{ url: string; embed?: Record<string, unknown> | null }>>();
  if (messageIds.length === 0) return { mediaByMsg, linkEmbedsByMsg };

  const idPh = messageIds.map(() => "?").join(",");
  const embedRows = await db
    .query(
      `select e.room as message_id, ei.entity as url,
              ei.mime_type as mime_type, ei.alt as alt,
              ei.width as width, ei.height as height,
              ei.blurhash as blurhash, ei.size as size,
              null as length, null as name
         from comp_embed_image ei
         join entities e on e.id = ei.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, ev.entity as url,
              ev.mime_type as mime_type, ev.alt as alt,
              ev.width as width, ev.height as height,
              ev.blurhash as blurhash, ev.size as size,
              ev.length as length, null as name
         from comp_embed_video ev
         join entities e on e.id = ev.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, ef.entity as url,
              ef.mime_type as mime_type, null as alt,
              null as width, null as height,
              null as blurhash, ef.size as size,
              null as length, ef.name as name
         from comp_embed_file ef
         join entities e on e.id = ef.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, el.entity as url,
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
    .all<EmbedRow>([...messageIds, ...messageIds, ...messageIds, ...messageIds]);

  // Collect link URLs so we can pull cached enrichment data in one query.
  const linkUrls = new Set<string>();
  for (const e of embedRows) {
    if (e.mime_type === "text/uri-list") linkUrls.add(e.url);
  }

  const linkEmbedDataMap = new Map<string, Record<string, unknown> | null>();
  if (linkUrls.size > 0) {
    const urlList = [...linkUrls];
    const ph = urlList.map(() => "?").join(",");
    const linkDataRows = await db
      .query(
        `select entity, embed_json from comp_embed_link_data
          where entity in (${ph})`,
      )
      .all<{ entity: string; embed_json: string | null }>([...urlList]);
    for (const row of linkDataRows) {
      linkEmbedDataMap.set(
        row.entity,
        row.embed_json ? (JSON.parse(row.embed_json) as Record<string, unknown>) : null,
      );
    }
  }

  for (const e of embedRows) {
    if (e.mime_type === "text/uri-list") {
      let arr = linkEmbedsByMsg.get(e.message_id);
      if (!arr) {
        arr = [];
        linkEmbedsByMsg.set(e.message_id, arr);
      }
      const embedData = linkEmbedDataMap.get(e.url);
      arr.push({
        url: e.url,
        ...(embedData != null ? { embed: embedData } : {}),
      });
    } else {
      let arr = mediaByMsg.get(e.message_id);
      if (!arr) {
        arr = [];
        mediaByMsg.set(e.message_id, arr);
      }
      arr.push({
        url: e.url, type: e.mime_type,
        ...(e.alt != null ? { alt: e.alt } : {}),
        ...(e.width != null ? { width: e.width } : {}),
        ...(e.height != null ? { height: e.height } : {}),
        ...(e.blurhash != null ? { blurhash: e.blurhash } : {}),
        ...(e.size != null ? { size: e.size } : {}),
        ...(e.length != null ? { length: e.length } : {}),
        ...(e.name != null ? { name: e.name } : {}),
      });
    }
  }

  return { mediaByMsg, linkEmbedsByMsg };
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