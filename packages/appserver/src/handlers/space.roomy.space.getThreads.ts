/**
 * XRPC: space.roomy.space.getThreads (query).
 *
 * Returns all rooms (channels + threads) in a space for the index board,
 * ordered by latest activity, filtered by the caller's read access (a room
 * is hidden when it is unreadable to the caller; threads inherit access
 * from their canonical parent channel).
 *
 * Supports cursor-based pagination via `limit` and `cursor` params.
 */

import { createAccessMemo, roomAccessMany } from "../auth/access.ts";
import { openReadStateDb, openSpaceDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { getEngagedThreadIds, getReadPositions } from "../queries/readPositions.ts";
import { parseUserDid, requireSpaceRead } from "../xrpc/authGuards.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface RoomRow {
  id: string;
  kind: "thread" | "channel";
  name?: string;
  /** Parent channel ID (threads only). */
  channel?: string;
  /** Parent channel name (threads only). */
  channelName?: string;
  unreadCount: number;
  /**
   * Honest unread flag for the board: has messages and (unreadCount > 0 or,
   * for threads, not engaged). Channels use plain unreadCount > 0, matching
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

interface GetThreadsResult {
  rooms: RoomRow[];
  cursor?: string;
}

export const getSpaceThreadsHandler: QueryHandler<
  QueryParams,
  GetThreadsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = requireString(params, "spaceId");
  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 50 })!;
  const cursor = optionalString(params, "cursor") ?? null;
  const search = optionalString(params, "search") ?? null;

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openSpaceDb(spaceId);
  const mainDb = openReadStateDb();
  // Per-request memo: every room in this space shares the same space-level
  // membership/admin/ban flags — without the memo, each roomAccess call
  // re-queries them (~5 queries × N rooms).
  const memo = createAccessMemo();
  await requireSpaceRead(db, spaceId, userDid, memo);

  // The index board shows channels AND threads, ordered by activity.
  const { threads: all, cursor: nextCursor } = await listThreadActivity(
    db,
    { kind: "space", spaceId },
    limit,
    cursor,
    search,
    { kinds: ["thread", "channel"] },
  );

  // Collect all room IDs for batch unread lookup.
  const roomIds = all.map((t) => t.id);
  const readPositions = auth.did ? await getReadPositions(mainDb, auth.did, roomIds) : new Map();
  // Threads the user has never engaged with have no read_positions row of
  // their own — they read as unread in the board even though their
  // unreadCount is 0 (the honest view of what you have and haven't read).
  const engagedThreadIds = auth.did
    ? await getEngagedThreadIds(mainDb, auth.did, roomIds)
    : new Set<string>();

  // Batch-fetch channel names for all canonical parents.
  const parentIds = [...new Set(all.map((t) => t.canonicalParent).filter(Boolean))] as string[];
  const channelNames = new Map<string, string>();
  if (parentIds.length > 0) {
    const ph = parentIds.map(() => "?").join(",");
    const rows = await db
      .query(
        `select e.id as id, ci.name as name
           from entities e
           left join comp_info ci on ci.entity = e.id
          where e.id in (${ph})`,
      )
      .all<{ id: string; name: string | null }>(...parentIds);
    for (const r of rows) {
      if (r.name != null) channelNames.set(r.id as string, r.name);
    }
  }

  // Resolve read access for every room in one batched pass instead of one
  // `roomAccess` round-trip per room (up to 100 rooms → ~300–400 per-space
  // DB round-trips). Thread visibility hangs off the canonical parent channel
  // — the auth unit computes that via the 'link' edge, matching the spec's
  // "channel grants visibility" model.
  const accessByRoom = await roomAccessMany(db, all.map((t) => t.id), userDid, memo);

  const rooms: RoomRow[] = [];
  for (const t of all) {
    const acc = accessByRoom.get(t.id);
    if (!acc || !acc.canRead) continue;
    const members = t.latestMembers.map((m) => ({
      did: m.did,
      name: m.name,
      avatar: m.avatar,
    }));
    const activity: RoomRow["activity"] = {
      latestMembers: members,
    };
    if (t.latestTimestamp != null) activity.latestTimestamp = t.latestTimestamp;
    if (t.latestMessage != null) {
      const author: { did: string; name: string | null; avatar: string | null } = {
        did: t.latestMessage.author.did,
        name: t.latestMessage.author.name ?? null,
        avatar: t.latestMessage.author.avatar ?? null,
      };
      activity.latestMessage = {
        id: t.latestMessage.id,
        content: t.latestMessage.content,
        author,
        timestamp: t.latestMessage.timestamp,
      };
    }

    const pos = readPositions.get(t.id);
    const unreadCount = pos?.unreadCount ?? 0;
    const isThread = t.kind === "thread";
    const room: RoomRow = {
      id: t.id,
      kind: t.kind,
      activity,
      unreadCount,
      // Channels: plain unreadCount > 0 (matches the sidebar). Threads:
      // honest flag — unread unless read and engaged.
      unread: t.latestTimestamp != null && (unreadCount > 0 || (isThread && !engagedThreadIds.has(t.id))),
    };
    if (t.name != null) room.name = t.name;
    if (isThread && t.canonicalParent != null) {
      room.channel = t.canonicalParent;
      const cn = channelNames.get(t.canonicalParent);
      if (cn != null) room.channelName = cn;
    }
    rooms.push(room);
  }

  const result: GetThreadsResult = { rooms };
  if (nextCursor) result.cursor = nextCursor;
  return result;
};
