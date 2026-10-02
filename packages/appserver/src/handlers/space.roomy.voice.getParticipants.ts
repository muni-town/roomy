/**
 * XRPC: space.roomy.voice.getParticipants (query).
 *
 * The projection is the source of truth for who is in a room's call: a client
 * re-reads it on reconnect and after any `#voicePresenceDiff`, and treats the
 * snapshot as authoritative over whatever it accumulated from frames.
 *
 * `callId` is the generation the list belongs to, so a client holding an
 * earlier one can tell that the call it was in has ended and has been replaced,
 * rather than merging two calls' participants.
 */

import { openSpaceDbForEntity } from "../db/db.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import { getLiveKit } from "../voice/livekit.ts";
import { activeCall, listParticipants } from "../voice/projection.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface VoiceParticipant {
  did: string;
  joinedAt?: number;
  source: string;
}

interface GetParticipantsResult {
  roomId: string;
  callId: string | null;
  participants: VoiceParticipant[];
}

export const getVoiceParticipantsHandler: QueryHandler<
  QueryParams,
  GetParticipantsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");

  const db = await openSpaceDbForEntity(roomId);
  if (!db) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  await requireRoomRead(db, roomId, userDid);

  const call = await activeCall(db, roomId);
  // Unconfigured LiveKit means no call can exist, so this agrees with
  // getToken rather than reporting a projection that nothing can populate.
  if (!getLiveKit()) {
    return { roomId, callId: null, participants: [] };
  }

  if (!call) {
    return { roomId, callId: null, participants: [] };
  }

  const participants = await listParticipants(db, roomId);
  return {
    roomId,
    callId: call.callId,
    participants: participants.map(
      (p) => stripNulls({ did: p.did, joinedAt: p.joinedAt, source: p.source }) as VoiceParticipant,
    ),
  };
};
