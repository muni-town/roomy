/**
 * XRPC: space.roomy.space.getThreads (query).
 *
 * Returns threads in a space for the board/index view, filtered by the
 * caller's read access (a thread is hidden when its parent channel is
 * unreadable to the caller).
 *
 * Supports cursor-based pagination via `limit` and `cursor` params.
 */

import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { getReadPositions } from "../queries/readPositions.ts";
import { parseUserDid, requireSpaceRead } from "../xrpc/authGuards.ts";
import { optionalInt, optionalString, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ThreadRow {
  id: string;
  name?: string;
  channel?: string;
  channelName?: string;
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

interface GetThreadsResult {
  threads: ThreadRow[];
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

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openDb();
  await requireSpaceRead(db, spaceId, userDid);

  const { threads: all, cursor: nextCursor } = await listThreadActivity(db, { kind: "space", spaceId }, limit, cursor);

  // Collect all thread IDs for batch unread lookup
  const threadIds = all.map((t) => t.id);
  const readPositions = auth.did ? await getReadPositions(db, auth.did, threadIds) : new Map();

  // Batch-fetch channel names for all canonical parents
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

  const threads: ThreadRow[] = [];
  for (const t of all) {
    // Thread visibility hangs off the canonical parent channel — re-use
    // the auth unit to compute it. (The thread itself inherits via 'link',
    // so checking the thread directly would also work; checking via
    // canonicalParent matches the spec's "channel grants visibility" model.)
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
    if (t.canonicalParent != null) {
      thread.channel = t.canonicalParent;
      const cn = channelNames.get(t.canonicalParent);
      if (cn != null) thread.channelName = cn;
    }
    threads.push(thread);
  }

  const result: GetThreadsResult = { threads };
  if (nextCursor) result.cursor = nextCursor;
  return result;
};
