/**
 * XRPC: space.roomy.voice.getActiveCalls (query).
 *
 * Space-scoped: the rooms in one space that currently have a call, so the
 * sidebar can mark them. Scoped to a single space rather than global because
 * access is resolved per space — a global list would have to filter every
 * entry by membership anyway.
 *
 * Unconfigured LiveKit returns an empty list, not an error: nothing can have
 * started a call in that state, and a client rendering no call affordances is
 * the correct outcome rather than a failed sidebar query.
 */

import { openSpaceDb } from "../db/db.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import { getLiveKit } from "../voice/livekit.ts";
import { listActiveCalls } from "../voice/projection.ts";

interface ActiveCall {
  roomId: string;
  callId: string;
  startedAt: number;
  participantCount: number;
}

interface GetActiveCallsResult {
  calls: ActiveCall[];
}

export const getVoiceActiveCallsHandler: QueryHandler<
  QueryParams,
  GetActiveCallsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = requireString(params, "spaceId");

  const db = openSpaceDb(spaceId);
  // Membership, not public read: the list names which rooms have live calls,
  // which is not something a stranger to the space should learn.
  await requireSpaceAccess(db, spaceId, userDid);

  if (!getLiveKit()) return { calls: [] };

  const calls = await listActiveCalls(db, spaceId);
  return {
    calls: calls.map((c) => ({
      roomId: c.roomId,
      callId: c.callId,
      startedAt: c.startedAt,
      participantCount: c.participantCount,
    })),
  };
};
