/**
 * XRPC: space.roomy.search.rooms (query).
 *
 * Search channels and threads in a space by name (case-insensitive
 * substring), filtered by the caller's read access. Backs the forward
 * modal's room picker: unlike `space.getMetadata`'s `activeThreads`
 * (at most 8 recently-active threads per user), this finds every
 * non-deleted channel and thread whose name matches.
 *
 * Returns at most `limit` rooms (default 20, max 100) across both kinds,
 * channels first, each alphabetically by name. No cursor: the room picker
 * needs the top matches only; LIKE on a space's room names is cheap.
 *
 * Read-access filtering mirrors `getThreads` — a thread is hidden when its
 * canonical parent channel is unreadable to the caller (threads inherit
 * access from their parent channel).
 *
 * Per docs/plans/search-endpoints.md.
 */

import { createAccessMemo, roomAccess } from "../auth/access.ts";
import { openReadStateDb, openSpaceDb } from "../db/db.ts";
import { fetchRoomActivity } from "../queries/threadActivity.ts";
import { getEngagedThreadIds, getReadPositions, type ReadPosition } from "../queries/readPositions.ts";
import { parseUserDid, requireSpaceRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface RoomSearchResult {
  id: string;
  name: string;
  kind: "channel" | "thread";
  canWrite: boolean;
  /** Canonical parent channel id (threads only). */
  channelId?: string;
  /** Canonical parent channel name (threads only). */
  channelName?: string;
  unreadCount: number;
  /**
   * Honest unread flag for the board: true when the room has messages the
   * user hasn't read. For threads this includes never-engaged threads (no
   * read_positions row yet); for channels it's `unreadCount > 0`, matching
   * the sidebar's per-channel unread counts.
   */
  unread: boolean;
  activity: {
    latestTimestamp?: string;
    latestMembers: Array<{
      did: string;
      name: string | null;
      avatar: string | null;
    }>;
    latestMessage?: {
      id: string;
      content: string;
      author: {
        did: string;
        name: string | null;
        avatar: string | null;
      };
      timestamp: string | null;
    };
  };
}

interface SearchRoomsResult {
  rooms: RoomSearchResult[];
}

export const searchRoomsHandler: QueryHandler<
  QueryParams,
  SearchRoomsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = requireString(params, "spaceId");
  const q = requireString(params, "q").trim();
  if (q === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Param q must be a non-empty string",
    );
  }
  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 20 })!;

  if (userDid !== null) {
  }

  const db = openSpaceDb(spaceId);
  // Per-request memo: every room in this space shares the same space-level
  // membership/admin/ban flags — without the memo, each roomAccess call
  // re-queries them (~5 queries × N rooms).
  const memo = createAccessMemo();
  await requireSpaceRead(db, spaceId, userDid, memo);

  const like = `%${q}%`;
  const rooms: RoomSearchResult[] = [];

  // ── Channels first (alphabetical) ────────────────────────────────────
  const channels = await db
    .query(
      `select e.id as id, ci.name as name
         from entities e
         join comp_room cr on cr.entity = e.id
         join comp_info ci on ci.entity = e.id
        where e.stream_id = ?
          and cr.label = 'space.roomy.channel'
          and coalesce(cr.deleted, 0) = 0
          and ci.name like ?
        order by ci.name asc
        limit ?`,
    )
    .all<{ id: string; name: string }>(spaceId, like, limit);

  for (const ch of channels) {
    const acc = await roomAccess(db, ch.id, userDid, memo);
    if (!acc.canRead) continue;
    rooms.push({
      id: ch.id,
      name: ch.name,
      kind: "channel",
      canWrite: acc.canWrite,
      // Filled in by the batch activity pass below.
      unreadCount: 0,
      unread: false,
      activity: { latestMembers: [] },
    });
    if (rooms.length >= limit) break;
  }

  // ── Threads (alphabetical), with canonical parent channel context ────
  const threads = await db
    .query(
      `select e.id as id, ci.name as name
         from entities e
         join comp_room cr on cr.entity = e.id
         join comp_info ci on ci.entity = e.id
        where e.stream_id = ?
          and cr.label = 'space.roomy.thread'
          and coalesce(cr.deleted, 0) = 0
          and ci.name like ?
        order by ci.name asc
        limit ?`,
    )
    .all<{ id: string; name: string }>(spaceId, like, limit);

  if (threads.length > 0) {
    const threadIds = threads.map((t) => t.id);
    const ph = threadIds.map(() => "?").join(",");

    // Canonical parent channel per thread.
    const parentRows = await db
      .query(
        `select tail, head from edges
          where tail in (${ph})
            and label = 'link'
            and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1`,
      )
      .all<{ tail: string; head: string }>(...threadIds);
    const parentByThread = new Map(parentRows.map((r) => [r.tail, r.head]));

    // Parent channel names (batch).
    const parentIds = [...new Set(parentByThread.values())];
    const channelNames = new Map<string, string>();
    if (parentIds.length > 0) {
      const parentPh = parentIds.map(() => "?").join(",");
      const rows = await db
        .query(
          `select e.id as id, ci.name as name
             from entities e
             left join comp_info ci on ci.entity = e.id
            where e.id in (${parentPh})`,
        )
        .all<{ id: string; name: string | null }>(...parentIds);
      for (const r of rows) {
        if (r.name != null) channelNames.set(r.id, r.name);
      }
    }

    for (const t of threads) {
      if (rooms.length >= limit) break;
      const acc = await roomAccess(db, t.id, userDid, memo);
      if (!acc.canRead) continue;
      const item: RoomSearchResult = {
        id: t.id,
        name: t.name,
        kind: "thread",
        canWrite: acc.canWrite,
        // Filled in by the batch activity pass below.
        unreadCount: 0,
        unread: false,
        activity: { latestMembers: [] },
      };
      const parentId = parentByThread.get(t.id);
      if (parentId) {
        item.channelId = parentId;
        const cn = channelNames.get(parentId);
        if (cn != null) item.channelName = cn;
      }
      rooms.push(item);
    }
  }

  // ── Activity + unread (batch) ───────────────────────────────────────
  // The board rows render activity columns (avatars, latest message, date)
  // and unread state, so each result carries the same shape as
  // `space.getThreads`. Fetched in one batched pass over the matched rooms.
  if (rooms.length > 0) {
    const roomIds = rooms.map((r) => r.id);
    const activityByRoom = await fetchRoomActivity(db, roomIds);
    const readStateDb = openReadStateDb();
    const readPositions = userDid
      ? await getReadPositions(readStateDb, db, userDid, roomIds)
      : new Map();
    const engagedThreadIds = userDid
      ? await getEngagedThreadIds(readStateDb, userDid, roomIds)
      : new Set<string>();

    for (const room of rooms) {
      const act = activityByRoom.get(room.id);
      const activity: RoomSearchResult["activity"] = {
        latestMembers: act?.latestMembers ?? [],
      };
      if (act?.latestTimestamp != null) {
        activity.latestTimestamp = act.latestTimestamp;
      }
      if (act?.latestMessage != null) {
        activity.latestMessage = {
          id: act.latestMessage.id,
          content: act.latestMessage.content,
          author: {
            did: act.latestMessage.author.did,
            name: act.latestMessage.author.name,
            avatar: act.latestMessage.author.avatar,
          },
          timestamp: act.latestMessage.timestamp,
        };
      }
      room.activity = activity;

      const pos = readPositions.get(room.id);
      const unreadCount = pos?.unreadCount ?? 0;
      room.unreadCount = unreadCount;
      // Channels: plain unreadCount > 0 (matches the sidebar). Threads:
      // honest flag — unread unless read and engaged.
      room.unread =
        act?.latestTimestamp != null &&
        (unreadCount > 0 ||
          (room.kind === "thread" && !engagedThreadIds.has(room.id)));
    }
  }

  return { rooms };
};
