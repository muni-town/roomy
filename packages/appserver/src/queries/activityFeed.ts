/**
 * Activity feed query helper.
 *
 * Reads from the `activity_item` table (materialized on createMessage events)
 * and joins the recent message IDs against the full message data at query time.
 *
 * Results are sorted newest-first and support cursor-based pagination.
 * The caller is responsible for filtering by room-level read access.
 */

import type { Database } from "bun:sqlite";
import { decodeContent } from "../db/content.ts";

// ─── Types ────────────────────────────────────────────────────────────────

export interface ActivityAuthor {
  did: string;
  name?: string;
  avatar?: string;
}

export interface ActivityMessage {
  id: string;
  content: string;
  author: ActivityAuthor;
  timestamp?: string;
  /** Media attachments (images/video/files). Only hydrated on the latest message. */
  media?: Array<{ url: string; type: string; alt?: string }>;
  /** Link embeds with enriched metadata. Only hydrated on the latest message. */
  linkEmbeds?: Array<{ url: string; embed?: Record<string, unknown> | null }>;
  /** Reactions on the message. Only hydrated on the latest message. */
  reactions?: Array<{ emoji: string; dids: string[]; myReactionId?: string }>;
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

// ─── Query ────────────────────────────────────────────────────────────────

export function selectActivityFeed(
  db: Database,
  userDid: string,
  personalStreamDid: string,
  scope: ActivityFeedScope,
): { feed: ActivityFeedItem[]; cursor: string | null } {
  // Step 1: fetch the raw activity_item rows, filtered and paginated.
  const spaceFilter = scope.spaceId;

  // Build the WHERE clause dynamically.
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // Always filter by joined spaces (or a specific space).
  if (spaceFilter) {
    conditions.push("ai.space_id = ?");
    params.push(spaceFilter);
  } else {
    conditions.push("ai.space_id in (select tail from edges where head = ? and label = 'joinedSpace')");
    params.push(personalStreamDid);
  }

  // Filter out deleted rooms.
  conditions.push("(cr.deleted is null or cr.deleted = 0)");

  // Cursor pagination: newest-first.
  // Cursor format: "timestamp::roomId"
  if (scope.cursor) {
    const sepIdx = scope.cursor.lastIndexOf("::");
    if (sepIdx !== -1) {
      const cursorTs = Number(scope.cursor.slice(0, sepIdx));
      const cursorId = scope.cursor.slice(sepIdx + 2);
      conditions.push(
        "(ai.last_activity_at < ? or (ai.last_activity_at = ? and ai.room_id < ?))",
      );
      params.push(cursorTs, cursorTs, cursorId);
    }
  }

  const whereClause = conditions.join(" and ");

  const rows = db
    .query<
      {
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
      },
      (string | number)[]
    >(
      `select
         ai.room_id, ai.space_id, ai.is_thread,
         ai.parent_channel_id, ai.parent_channel_name,
         ai.last_activity_at, ai.recent_message_ids,
         ai.room_name, ai.space_name, ai.space_avatar
       from activity_item ai
       left join comp_room cr on cr.entity = ai.room_id
       where ${whereClause}
       order by ai.last_activity_at desc, ai.room_id desc
       limit ?`,
    )
    .all(...params, scope.limit + 1);

  if (rows.length === 0) return { feed: [], cursor: null };

  // Fetch one extra row to determine if there are more pages.
  const hasMore = rows.length > scope.limit;
  const pageRows = hasMore ? rows.slice(0, scope.limit) : rows;

  // Step 2: collect all message IDs from the page and batch-query their data.
  const allMessageIds: string[] = [];
  for (const r of pageRows) {
    const ids: string[] = JSON.parse(r.recent_message_ids);
    allMessageIds.push(...ids);
  }

  const messagesData = allMessageIds.length > 0
    ? batchFetchMessages(db, allMessageIds)
    : new Map<string, ActivityMessage>();

  // Step 3: fetch unread counts for all rooms on the page.
  const roomIds = pageRows.map((r) => r.room_id);
  const unreadCounts = batchFetchUnreadCounts(db, userDid, roomIds);

  // Step 4: assemble feed items.
  const feed: ActivityFeedItem[] = pageRows.map((r) => {
    const messageIds: string[] = JSON.parse(r.recent_message_ids);
    const messages: ActivityMessage[] = [];
    for (const mid of messageIds) {
      const msg = messagesData.get(mid);
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

  // Step 4.5: hydrate media + link embeds + reactions for the LATEST message of
  // each feed item only. `recent_message_ids` is stored newest-first, so the
  // latest message is at index 0. Preceding context messages stay text-only to
  // keep the payload light.
  const lastMsgIds = feed
    .map((it) => it.messages[0]?.id)
    .filter((id): id is string => id != null);
  if (lastMsgIds.length > 0) {
    const { mediaByMsg, linkEmbedsByMsg } = batchFetchEmbeds(db, lastMsgIds);
    const reactionsByMsg = batchFetchReactions(db, lastMsgIds, userDid);
    for (const it of feed) {
      const last = it.messages[0];
      if (!last) continue;
      const media = mediaByMsg.get(last.id);
      if (media && media.length > 0) last.media = media;
      const linkEmbeds = linkEmbedsByMsg.get(last.id);
      if (linkEmbeds && linkEmbeds.length > 0) last.linkEmbeds = linkEmbeds;
      const reactions = reactionsByMsg.get(last.id);
      if (reactions && reactions.length > 0) last.reactions = reactions;
    }
  }

  // Step 5: compute the next cursor.
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
  author_avatar: string | null;
  timestamp: number | null;
}

/**
 * Batch-fetch full message data for a set of message IDs.
 * Returns a Map<messageId, ActivityMessage>.
 */
function batchFetchMessages(
  db: Database,
  messageIds: string[],
): Map<string, ActivityMessage> {
  const result = new Map<string, ActivityMessage>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db
    .query<MessageRow, string[]>(
      `select
         e.id as id,
         cc.mime_type as mime_type,
         cc.data as data,
         coalesce(author_e.tail, '') as author_did,
         author_info.name as author_name,
         author_info.avatar as author_avatar,
         cc.timestamp as timestamp
       from entities e
       left join comp_content cc on cc.entity = e.id
       left join edges author_e
         on author_e.head = e.id and author_e.label = 'author'
       left join comp_info author_info on author_info.entity = author_e.tail
       where e.id in (${placeholders})`,
    )
    .all(...messageIds);

  for (const r of rows) {
    result.set(r.id, {
      id: r.id,
      content: decodeContent(r.mime_type, r.data),
      author: {
        did: r.author_did ?? "",
        ...(r.author_name != null ? { name: r.author_name } : {}),
        ...(r.author_avatar != null ? { avatar: r.author_avatar } : {}),
      },
      ...(r.timestamp != null ? { timestamp: new Date(r.timestamp).toISOString() } : {}),
    });
  }

  return result;
}

/**
 * Batch-fetch unread counts for a set of room IDs.
 * Returns a Map<roomId, unreadCount>.
 *
 * Uses a single batched query (WHERE IN) rather than N individual
 * prepared statements. The readstate DB is ATTACHed to the main DB
 * as "readstate" at startup, so cross-database queries work fine.
 */
function batchFetchUnreadCounts(
  db: Database,
  userDid: string,
  roomIds: string[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (roomIds.length === 0) return result;

  const placeholders = roomIds.map(() => "?").join(",");
  const rows = db
    .query<
      { room_id: string; unread_count: number },
      [string, ...string[]]
    >(
      `select room_id, unread_count
         from readstate.read_positions
        where user_did = ? and room_id in (${placeholders})`,
    )
    .all(userDid, ...roomIds);

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
}

/**
 * Batch-fetch media attachments + link embeds for a set of message IDs.
 *
 * Mirrors the embed query in `selectMessages.ts`: a single UNION ALL across
 * comp_embed_image / _video / _file / _link joined to `entities` (whose `room`
 * points at the owning message), then a follow-up query for cached link-embed
 * enrichment data. Returns two maps keyed by message ID.
 */
function batchFetchEmbeds(
  db: Database,
  messageIds: string[],
): {
  mediaByMsg: Map<string, Array<{ url: string; type: string; alt?: string }>>;
  linkEmbedsByMsg: Map<string, Array<{ url: string; embed?: Record<string, unknown> | null }>>;
} {
  const mediaByMsg = new Map<string, Array<{ url: string; type: string; alt?: string }>>();
  const linkEmbedsByMsg = new Map<string, Array<{ url: string; embed?: Record<string, unknown> | null }>>();
  if (messageIds.length === 0) return { mediaByMsg, linkEmbedsByMsg };

  const idPh = messageIds.map(() => "?").join(",");
  const embedRows = db
    .query<EmbedRow, string[]>(
      `select e.room as message_id, ei.entity as url,
              ei.mime_type as mime_type, ei.alt as alt
         from comp_embed_image ei
         join entities e on e.id = ei.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, ev.entity as url,
              ev.mime_type as mime_type, ev.alt as alt
         from comp_embed_video ev
         join entities e on e.id = ev.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, ef.entity as url,
              ef.mime_type as mime_type, null as alt
         from comp_embed_file ef
         join entities e on e.id = ef.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, el.entity as url,
              'text/uri-list' as mime_type, null as alt
         from comp_embed_link el
         join entities e on e.id = el.entity
        where e.room in (${idPh})`,
    )
    // Each UNION branch has its own `where ... in (${idPh})` — bind ids
    // once per branch (4× total). bun:sqlite has no positional reuse here.
    .all(...messageIds, ...messageIds, ...messageIds, ...messageIds);

  // Collect link URLs so we can pull cached enrichment data in one query.
  const linkUrls = new Set<string>();
  for (const e of embedRows) {
    if (e.mime_type === "text/uri-list") linkUrls.add(e.url);
  }

  const linkEmbedDataMap = new Map<string, Record<string, unknown> | null>();
  if (linkUrls.size > 0) {
    const urlList = [...linkUrls];
    const ph = urlList.map(() => "?").join(",");
    const linkDataRows = db
      .query<{ entity: string; embed_json: string | null }, string[]>(
        `select entity, embed_json from comp_embed_link_data
          where entity in (${ph})`,
      )
      .all(...urlList);
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
        url: e.url, type: e.mime_type, ...(e.alt != null ? { alt: e.alt } : {}) });
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
function batchFetchReactions(
  db: Database,
  messageIds: string[],
  viewerDid?: string,
): Map<string, Array<{ emoji: string; dids: string[]; myReactionId?: string }>> {
  const result = new Map<string, Array<{ emoji: string; dids: string[]; myReactionId?: string }>>();
  if (messageIds.length === 0) return result;

  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db
    .query<ReactionRow, string[]>(
      `select entity, reaction, user, reaction_id from comp_reaction
        where entity in (${placeholders})`,
    )
    .all(...messageIds);

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
    const arr: Array<{ emoji: string; dids: string[]; myReactionId?: string }> = [];
    for (const [emoji, dids] of perMsg.entries()) {
      const myReactionId = perMsgViewer?.get(emoji);
      arr.push({
        emoji,
        dids: [...dids].sort(),
        ...(myReactionId != null ? { myReactionId } : {}),
      });
    }
    result.set(entity, arr);
  }

  return result;
}