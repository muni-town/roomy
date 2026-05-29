/**
 * XRPC: space.roomy.room.getThreads (query).
 *
 * All threads canonically linked from the given channel, filtered by the
 * caller's read access.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { listThreadActivity } from "../queries/threadActivity.ts";
import { requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ThreadRow {
  id: string;
  name?: string;
  canonicalParent?: string;
  activity: {
    latestTimestamp?: string;
    latestMembers: Array<{
      did: string;
      name?: string;
      avatar?: string;
    }>;
  };
}

interface GetRoomThreadsResult {
  threads: ThreadRow[];
}

export const getRoomThreadsHandler: QueryHandler<
  QueryParams,
  GetRoomThreadsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }
  const roomId = requireString(params, "roomId");

  await hydrateUserMembership(userDid);

  const db = openDb();
  requireRoomRead(db, roomId, userDid);

  const all = listThreadActivity(db, { kind: "channel", channelId: roomId });

  const threads: ThreadRow[] = [];
  for (const t of all) {
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
    if (t.canonicalParent != null) thread.canonicalParent = t.canonicalParent;
    threads.push(thread);
  }

  return { threads };
};
