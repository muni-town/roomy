/**
 * XRPC: space.roomy.room.getThreads (query).
 *
 * All threads canonically linked from the given channel, filtered by the
 * caller's read access.
 *
 * Supports cursor-based pagination via `limit` and `cursor` params.
 */

import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { getReadPositions } from "../queries/readPositions.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ThreadRow {
  id: string;
  name?: string;
  canonicalParent?: string;
  unreadCount: number;
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

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openDb();
  await requireRoomRead(db, roomId, userDid);

  const { threads: all, cursor: nextCursor } = await listThreadActivity(db, { kind: "channel", channelId: roomId }, limit, cursor);

  // Collect all thread IDs for batch unread lookup
  const threadIds = all.map((t) => t.id);
  const readPositions = auth.did ? await getReadPositions(db, auth.did, threadIds) : new Map();

  const threads: ThreadRow[] = [];
  for (const t of all) {
    const acc = await roomAccess(db, t.id, userDid);
    if (!acc.canRead) continue;
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

    const thread: ThreadRow = { id: t.id, activity, unreadCount: readPositions.get(t.id)?.unreadCount ?? 0 };
    if (t.name != null) thread.name = t.name;
    if (t.canonicalParent != null) thread.canonicalParent = t.canonicalParent;
    threads.push(thread);
  }

  const result: GetRoomThreadsResult = { threads };
  if (nextCursor) result.cursor = nextCursor;
  return result;
};
