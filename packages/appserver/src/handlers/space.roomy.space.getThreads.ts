/**
 * XRPC: space.roomy.space.getThreads (query).
 *
 * Returns all threads in a space for the board/index view, filtered by the
 * caller's read access (a thread is hidden when its parent channel is
 * unreadable to the caller).
 */

import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { getReadPositions } from "../queries/readPositions.ts";
import { parseUserDid, requireSpaceRead } from "../xrpc/authGuards.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ThreadRow {
  id: string;
  name?: string;
  channel?: string;
  unreadCount: number;
  activity: {
    latestTimestamp?: string;
    latestMembers: Array<{
      did: string;
      name?: string;
      avatar?: string;
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
}

export const getSpaceThreadsHandler: QueryHandler<
  QueryParams,
  GetThreadsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = requireString(params, "spaceId");

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openDb();
  requireSpaceRead(db, spaceId, userDid);

  const all = listThreadActivity(db, { kind: "space", spaceId });

  // Collect all thread IDs for batch unread lookup
  const threadIds = all.map((t) => t.id);
  const readPositions = auth.did ? getReadPositions(db, auth.did, threadIds) : new Map();

  const threads: ThreadRow[] = [];
  for (const t of all) {
    // Thread visibility hangs off the canonical parent channel — re-use
    // the auth unit to compute it. (The thread itself inherits via 'link',
    // so checking the thread directly would also work; checking via
    // canonicalParent matches the spec's "channel grants visibility" model.)
    const acc = roomAccess(db, t.id, userDid);
    if (!acc.canRead) continue;
    const members = t.latestMembers.map((m) => {
      const out: { did: string; name?: string; avatar?: string } = { did: m.did };
      if (m.name != null) out.name = m.name;
      if (m.avatar != null) out.avatar = m.avatar;
      return out;
    });
    const activity: ThreadRow["activity"] = {
      latestMembers: members,
    };
    if (t.latestTimestamp != null) activity.latestTimestamp = t.latestTimestamp;
    if (t.latestMessage != null) activity.latestMessage = {
      id: t.latestMessage.id,
      content: t.latestMessage.content,
      author: {
        did: t.latestMessage.author.did,
        name: t.latestMessage.author.name,
        avatar: t.latestMessage.author.avatar,
      },
      timestamp: t.latestMessage.timestamp,
    };

    const thread: ThreadRow = { id: t.id, activity, unreadCount: readPositions.get(t.id)?.unreadCount ?? 0 };
    if (t.name != null) thread.name = t.name;
    if (t.canonicalParent != null) thread.channel = t.canonicalParent;
    threads.push(thread);
  }

  return { threads };
};
