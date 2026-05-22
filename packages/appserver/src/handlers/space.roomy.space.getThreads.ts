/**
 * XRPC: space.roomy.space.getThreads (query).
 *
 * Returns all threads in a space for the board/index view, filtered by the
 * caller's read access (a thread is hidden when its parent channel is
 * unreadable to the caller).
 */

import { type, UserDid } from "@roomy-space/sdk";
import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ThreadRow {
  id: string;
  name?: string;
  channel?: string;
  activity: {
    latestTimestamp?: string;
    latestMembers: Array<{
      did: string;
      name?: string;
      avatar?: string;
    }>;
  };
}

interface GetThreadsResult {
  threads: ThreadRow[];
}

export const getSpaceThreadsHandler: QueryHandler<
  QueryParams,
  GetThreadsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }
  const spaceId = requireString(params, "spaceId");

  await hydrateUserMembership(userDid);

  const db = openDb();
  requireSpaceAccess(db, spaceId, userDid);

  const all = listThreadActivity(db, { kind: "space", spaceId });

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
    const activity: { latestTimestamp?: string; latestMembers: typeof members } = {
      latestMembers: members,
    };
    if (t.latestTimestamp != null) activity.latestTimestamp = t.latestTimestamp;

    const thread: ThreadRow = { id: t.id, activity };
    if (t.name != null) thread.name = t.name;
    if (t.canonicalParent != null) thread.channel = t.canonicalParent;
    threads.push(thread);
  }

  return { threads };
};
