/**
 * LiveKit access tokens and room names.
 *
 * A token is a plain HS256 JWT over the API secret — minting one needs no
 * network call, which is why the whole token path is unit-testable without a
 * LiveKit deployment. The `video` grant is the room name and LiveKit's own
 * claim set; everything the client needs to render a participant card rides in
 * `metadata`, so the client does not have to fetch profiles before connecting.
 *
 * `verifyLiveKitWebhook` and `resolveRoomName` live here too: both are pure
 * functions over the same secret and the same room-name scheme, so a test can
 * mint a request the way LiveKit would and check the pipeline end to end.
 */

import { createHash, createHmac } from "node:crypto";
import { StreamDid } from "@roomy-space/sdk";
import { LIVEKIT_TOKEN_TTL_SECONDS, type LiveKitConfig } from "./livekit.ts";

/**
 * The call's LiveKit room name: `{serverId}.{spaceId}.{roomId}@{callId}`.
 *
 * The `@{callId}` suffix is what makes a stale webhook harmless: LiveKit keeps
 * sending events for a room after the appserver has moved on to the next call
 * in that Roomy room, and the suffix lets the handler attribute each event to
 * one call generation and drop the rest.
 */
export function liveKitRoomName(
  config: LiveKitConfig,
  spaceId: string,
  roomId: string,
  callId: string,
): string {
  return `${config.serverId}.${spaceId}.${roomId}@${callId}`;
}

/** What the room-name suffix encodes, as parsed back off a LiveKit event. */
export interface ParsedRoomName {
  serverId: string;
  spaceId: string;
  roomId: string;
  callId: string;
}

/**
 * Parse a LiveKit room name produced by {@link liveKitRoomName}.
 *
 * Returns null for anything else — another deployment's rooms share the same
 * LiveKit project when `LIVEKIT_SERVER_ID` matches, and a malformed name must
 * be ignored rather than guessed at.
 */
export function parseLiveKitRoomName(name: string): ParsedRoomName | null {
  const at = name.lastIndexOf("@");
  if (at <= 0) return null;
  const callId = name.slice(at + 1);
  const head = name.slice(0, at);
  // The room id is the LAST dot-separated segment and the server id the first:
  // a `did:web:` space DID contains dots, so scanning forward from the server
  // segment would attribute part of the DID to the room.
  const firstDot = head.indexOf(".");
  const lastDot = head.lastIndexOf(".");
  if (!callId || firstDot <= 0 || lastDot <= firstDot) return null;
  const serverId = head.slice(0, firstDot);
  const spaceId = head.slice(firstDot + 1, lastDot);
  const roomId = head.slice(lastDot + 1);
  if (!spaceId || !roomId) return null;
  return { serverId, spaceId, roomId, callId };
}

/** Identity embedded in the token's `metadata` so the client renders a card
 *  without a profile round-trip. */
export interface LiveKitParticipantMetadata {
  did: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}


/** Where a room-name suffix says a webhook's event belongs. */
export interface ResolvedRoomName {
  spaceId: StreamDid;
  roomId: string;
  callId: string;
}

/**
 * Resolve a LiveKit room name to the Roomy room and call generation it names,
 * or null when it is not one of ours.
 *
 * Rejects a name whose server segment differs from ours: a LiveKit project can
 * be shared between deployments, and attributing another deployment's event to
 * our rooms would corrupt the projection.
 */
export function resolveRoomName(
  name: string,
  serverId: string,
): ResolvedRoomName | null {
  const parsed = parseLiveKitRoomName(name);
  if (!parsed || parsed.serverId !== serverId) return null;
  return {
    spaceId: StreamDid.assert(parsed.spaceId),
    roomId: parsed.roomId,
    callId: parsed.callId,
  };
}

export interface MintedToken {
  token: string;
  expiresAt: number;
}

/**
 * Mint a LiveKit access token for one participant in one call.
 *
 * `identity` is the participant's DID: it is what LiveKit echoes back on
 * webhooks, and what the call-fact pipeline matches against the projection.
 */
export function mintLiveKitToken(
  config: LiveKitConfig,
  roomName: string,
  did: string,
  metadata: LiveKitParticipantMetadata,
  now = Date.now(),
): MintedToken {
  const iat = Math.floor(now / 1000);
  const exp = iat + LIVEKIT_TOKEN_TTL_SECONDS;
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: config.apiKey,
    sub: did,
    nbf: iat,
    iat,
    exp,
    name: metadata.displayName ?? metadata.handle ?? did,
    metadata: JSON.stringify(metadata),
    video: {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };

  const encodedHeader = base64Url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64Url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", config.apiSecret)
    .update(signingInput)
    .digest();

  return {
    token: `${signingInput}.${base64Url(signature)}`,
    expiresAt: exp * 1000,
  };
}

/**
 * Verify a webhook's `Authorization` header and return its body.
 *
 * LiveKit signs the raw request body: the `Authorization` header carries a JWT
 * whose `sha256` claim is a base64url SHA-256 of that body, with the JWT itself
 * signed by the webhook secret. Verification therefore has to see the raw body
 * — a re-serialised copy would no longer hash to the same value.
 */
export function verifyLiveKitWebhook(
  config: LiveKitConfig,
  authorization: string | null,
  body: Buffer,
): boolean {
  if (!authorization) return false;
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : authorization;
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  // Reject an expired token before spending HMAC work: the claim set is
  // readable without the secret, and only the signature proves authenticity.
  let claims: { exp?: number; sha256?: string };
  try {
    claims = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { exp?: number; sha256?: string };
  } catch {
    return false;
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
    return false;
  }

  const expectedSignature = createHmac("sha256", config.webhookSecret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  const actualSignature = Buffer.from(parts[2]!, "base64url");
  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return false;
  }

  // The signature authenticates the token; the `sha256` claim binds that token
  // to this request body. It is a plain base64url SHA-256 of the raw body —
  // unsigned, because the signature above already covers it.
  if (typeof claims.sha256 !== "string") return false;
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return timingSafeEqual(Buffer.from(claims.sha256), Buffer.from(bodyHash));
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Constant-time comparison over equal-length buffers. */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
