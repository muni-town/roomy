/**
 * XRPC: space.roomy.room.getThreads (query).
 *
 * All threads canonically linked from the given channel, filtered by the
 * caller's read access.
 *
 * Supports cursor-based pagination via `limit` and `cursor` params.
 */

import { createAccessMemo, roomAccessMany } from "../auth/access.ts";
import { openReadStateDb, openSpaceDbForEntity } from "../db/db.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { getEngagedThreadIds, getReadPositions } from "../queries/readPositions.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ThreadRow {
  id: string;
  name?: string;
  canonicalParent?: string;
  unreadCount: number;
  /** Honest unread flag: has messages and (unreadCount > 0 or not engaged). */
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

interface GetRoomThreadsResult {
  threads: ThreadRow[];
  cursor?: string;
}

export const getRoomThreadsHandler: QueryHandler<
  QueryParams,
  GetRoomThreadsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");
  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 50 })!;
  const cursor = optionalString(params, "cursor") ?? null;
  const search = optionalString(params, "search") ?? null;

  if (userDid !== null) {
  }

  const db = await openSpaceDbForEntity(roomId);
  if (!db) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  const mainDb = openReadStateDb();
  // Per-request memo: all threads in this channel share the same space-level
  // membership/admin/ban flags — without the memo, each thread's roomAccess
  // call re-queries them (~5 queries × N threads).
  const memo = createAccessMemo();
  await requireRoomRead(db, roomId, userDid, memo);

  const { threads: all, cursor: nextCursor } = await listThreadActivity(db, { kind: "channel", channelId: roomId }, limit, cursor, search);

  // Collect all thread IDs for batch unread lookup
  const threadIds = all.map((t) => t.id);
  const readPositions = auth.did ? await getReadPositions(mainDb, auth.did, threadIds) : new Map();
  // Threads the user has never engaged with have no read_positions row of
  // their own — they read as unread in the threads view even though their
  // unreadCount is 0 (the honest view of what you have and haven't read).
  const engagedThreadIds = auth.did
    ? await getEngagedThreadIds(mainDb, auth.did, threadIds)
    : new Set<string>();

  const threads: ThreadRow[] = [];
  // One batched access pass for every thread in the page, instead of a
  // `roomAccess` round-trip per thread. With the `room_access` projection this
  // is a single per-space read for the whole page rather than N sequential
  // reads (measured: 13 threads → 1 round-trip).
  const accessByThread = await roomAccessMany(db, threadIds, userDid, memo);
  for (const t of all) {
    const acc = accessByThread.get(t.id);
    if (!acc?.canRead) continue;
    const members = t.latestMembers.map((m) => ({
      did: m.did,
      name: m.name,
      avatar: m.avatar,
    }));
    const activity: ThreadRow["activity"] = {
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
    const thread: ThreadRow = {
      id: t.id,
      activity,
      unreadCount,
      unread: t.latestTimestamp != null && (unreadCount > 0 || !engagedThreadIds.has(t.id)),
    };
    if (t.name != null) thread.name = t.name;
    if (t.canonicalParent != null) thread.canonicalParent = t.canonicalParent;
    threads.push(thread);
  }

  const result: GetRoomThreadsResult = { threads };
  if (nextCursor) result.cursor = nextCursor;
  return result;
};
