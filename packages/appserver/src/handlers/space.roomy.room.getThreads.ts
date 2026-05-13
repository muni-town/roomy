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
  name: string | null;
  canonicalParent: string | null;
  activity: {
    latestTimestamp: string | null;
    latestMembers: Array<{ did: string; name: string | null; avatar: string | null }>;
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
    threads.push({
      id: t.id,
      name: t.name,
      canonicalParent: t.canonicalParent,
      activity: {
        latestTimestamp: t.latestTimestamp,
        latestMembers: t.latestMembers,
      },
    });
  }

  return { threads };
};
