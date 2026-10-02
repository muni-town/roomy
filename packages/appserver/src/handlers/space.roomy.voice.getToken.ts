/**
 * XRPC: space.roomy.voice.getToken (query).
 *
 * Mints the caller's LiveKit access token plus the per-call E2EE key. The
 * token is a plain JWT: no LiveKit call is made, so this endpoint works
 * against an SFU unreachable from the appserver and is fully unit-testable.
 *
 * Room membership is the whole authorization gate — v1 has no dedicated voice
 * permission, so a caller who can read the room may join its call.
 *
 * This is also the first-join path: it starts the call when the room has none,
 * so a client can mint a token and connect without a separate join round-trip.
 */

import { StreamDid } from "@roomy-space/sdk";
import { openSpaceDbForEntity } from "../db/db.ts";
import { resolveProfiles } from "../queries/profileStore.ts";
import {
  parseUserDid,
  requireRoomRead,
  requireSpaceAccess,
} from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { ensureCall } from "../voice/callFacts.ts";
import { ensureCallE2eeKey } from "../voice/e2ee.ts";
import { getLiveKit, LIVEKIT_TOKEN_TTL_SECONDS } from "../voice/livekit.ts";
import { liveKitRoomName, mintLiveKitToken } from "../voice/tokens.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetTokenResult {
  token: string | null;
  callId: string | null;
  livekitUrl: string | null;
  e2eeKey: string | null;
  ttl: number | null;
}

/**
 * Every field null: LiveKit is unconfigured, so the caller renders no call UI.
 * Returning nulls rather than an error is what lets voice ship — and the
 * client's contract — exist before a deployment does.
 */
const UNCONFIGURED: GetTokenResult = {
  token: null,
  callId: null,
  livekitUrl: null,
  e2eeKey: null,
  ttl: null,
};

export const getVoiceTokenHandler: QueryHandler<
  QueryParams,
  GetTokenResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const roomId = requireString(params, "roomId");

  // A call is a room-membership action: v1 has no dedicated voice permission,
  // and read access alone is not enough — a public space is readable by
  // strangers, who must not be able to join (or start) its calls. Access is
  // resolved before configuration so a deployment without LiveKit answers "may
  // I?" identically.
  const db = await openSpaceDbForEntity(roomId);
  if (!db) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  const access = await requireRoomRead(db, roomId, userDid);
  if (userDid === null || access.spaceId === null) {
    throw new XrpcError(403, "Forbidden", "Sign in to join this call");
  }
  await requireSpaceAccess(db, access.spaceId, userDid);

  const config = getLiveKit();
  if (!config) return UNCONFIGURED;

  const spaceId = StreamDid.assert(access.spaceId);
  const callId = await ensureCall(
    db,
    { did: userDid, spaceId, roomId },
    "user",
  );

  const profiles = await resolveProfiles([userDid]);
  const profile = profiles.get(userDid);
  const minted = mintLiveKitToken(
    config,
    liveKitRoomName(config, spaceId, roomId, callId),
    userDid,
    {
      did: userDid,
      ...(profile?.handle != null ? { handle: profile.handle } : {}),
      ...(profile?.name != null ? { displayName: profile.name } : {}),
      ...(profile?.avatar != null ? { avatarUrl: profile.avatar } : {}),
    },
  );

  return {
    token: minted.token,
    callId,
    livekitUrl: config.url,
    // The key is per call and lives outside the event store, so a replayed
    // call's events never carry it.
    e2eeKey: await ensureCallE2eeKey(callId),
    ttl: LIVEKIT_TOKEN_TTL_SECONDS,
  };
};
