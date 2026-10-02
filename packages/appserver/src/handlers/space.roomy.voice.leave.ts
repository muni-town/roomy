/**
 * XRPC: space.roomy.voice.leave (procedure).
 *
 * Records the caller's leave intent. When the departing participant is the
 * last one the call ends — the same rule the LiveKit webhook applies, so the
 * projection does not depend on which path observed the empty room first.
 *
 * The resulting participant list reaches clients over the sync socket as a
 * `#voicePresenceDiff`; this procedure returns nothing.
 */

import { StreamDid, type Ulid } from "@roomy-space/sdk";
import { openSpaceDbForEntity } from "../db/db.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import {
  parseUserDid,
  requireRoomRead,
  requireSpaceAccess,
} from "../xrpc/authGuards.ts";
import { recordLeave } from "../voice/callFacts.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

export const voiceLeaveHandler: ProcedureHandler<
  Record<string, unknown>,
  void
> = async (params: QueryParams, auth: AuthCtx, body: Record<string, unknown>) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Sign in to leave a call");
  }
  const roomId = requireString(body as QueryParams, "roomId");

  const db = await openSpaceDbForEntity(roomId);
  if (!db) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  // Leaving uses read access plus membership rather than a write gate: a
  // participant whose write access was revoked mid-call must still be able to
  // leave it, while a stranger still cannot act on the call.
  const access = await requireRoomRead(db, roomId, userDid);
  if (access.spaceId === null) {
    throw new XrpcError(403, "Forbidden", "Cannot leave a call here");
  }
  await requireSpaceAccess(db, access.spaceId, userDid);
  await recordLeave(
    db,
    {
      did: userDid,
      spaceId: StreamDid.assert(access.spaceId),
      roomId: roomId as Ulid,
    },
    "user",
  );
};
