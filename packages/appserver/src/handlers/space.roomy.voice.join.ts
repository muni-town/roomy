/**
 * XRPC: space.roomy.voice.join (procedure).
 *
 * Records the caller's join intent as a durable call fact, before the client
 * connects to LiveKit, so the participant list is optimistic and survives a
 * failed media connection — a join that never reaches the SFU still shows the
 * intent, and the reconciler removes it on the next pass rather than the
 * client being invisible until it does.
 *
 * The LiveKit webhook later confirms the same transition; the duplicate is
 * collapsed, not appended twice.
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
import { recordJoin } from "../voice/callFacts.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

export const voiceJoinHandler: ProcedureHandler<
  Record<string, unknown>,
  void
> = async (params: QueryParams, auth: AuthCtx, body: Record<string, unknown>) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Sign in to join a call");
  }
  const roomId = requireString(body as QueryParams, "roomId");

  const db = await openSpaceDbForEntity(roomId);
  if (!db) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  const access = await requireRoomRead(db, roomId, userDid);
  if (access.spaceId === null) {
    throw new XrpcError(403, "Forbidden", "Cannot join a call here");
  }
  // Membership, not mere read access: a public space is readable by
  // strangers, who must not be able to join its calls.
  await requireSpaceAccess(db, access.spaceId, userDid);
  await recordJoin(
    db,
    {
      did: userDid,
      spaceId: StreamDid.assert(access.spaceId),
      roomId: roomId as Ulid,
    },
    "user",
  );
};
