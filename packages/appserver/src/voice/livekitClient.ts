/**
 * The LiveKit room-listing client the reconciler consumes.
 *
 * LiveKit's RoomService is a Twirp (Connect-protocol) JSON API on the SFU
 * origin. Listing rooms returns participant COUNTS; the reconciler compares
 * identities, so each room is followed by a participant listing. That is N+1
 * requests per pass, which is acceptable because a pass runs every 30 s and the
 * number of live calls is small — and it is what makes the comparison
 * meaningful rather than a count that cannot say WHO is missing.
 *
 * This is the only place the appserver talks to LiveKit. Everything else about
 * a call is inferred from webhooks and client intent, so an unreachable SFU
 * degrades the reconciler (it counts failures and eventually ends projected
 * calls) without affecting any request path.
 */

import { createHmac } from "node:crypto";
import { getLiveKit } from "./livekit.ts";
import type { LiveKitRoomLister, LiveKitRoomState } from "./reconciler.ts";

/** Service-token lifetime for one listing pass. */
const SERVICE_TOKEN_TTL_SECONDS = 60;

/** Per-request timeout: a pass must not hang the loop. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A lister backed by LiveKit's HTTP API.
 *
 * Returns no rooms when LiveKit is unconfigured. The reconciler is not started
 * in that state, and a caller that reaches here anyway must see "nothing to
 * reconcile" rather than a failure streak.
 */
export function createLiveKitRoomLister(): LiveKitRoomLister {
  return {
    async listRooms(): Promise<LiveKitRoomState[]> {
      const config = getLiveKit();
      if (!config) return [];

      // The HTTP origin: `LIVEKIT_URL` is the client-facing wss origin.
      const origin = config.url.replace(/^ws/, "http");
      const token = mintServiceToken(config.apiKey, config.apiSecret);

      const listed = await twirp<{
        rooms?: Array<{ name?: string }>;
      }>(origin, token, "livekit.RoomService/ListRooms", {});

      const rooms: LiveKitRoomState[] = [];
      for (const room of listed.rooms ?? []) {
        if (typeof room.name !== "string") continue;
        const participants = await twirp<{
          participants?: Array<{ identity?: string }>;
        }>(origin, token, "livekit.RoomService/ListParticipants", {
          room: room.name,
        });
        rooms.push({
          roomName: room.name,
          participantDids: (participants.participants ?? [])
            .map((p) => p.identity)
            .filter((id): id is string => typeof id === "string"),
        });
      }
      return rooms;
    },
  };
}

async function twirp<T>(
  origin: string,
  token: string,
  method: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${origin}/twirp/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `LiveKit ${method} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * A service JWT for the appserver's own LiveKit calls.
 *
 * Distinct from a participant token: no `video` grant — just the service
 * identity, which is what authorizes a room/participant listing.
 */
function mintServiceToken(apiKey: string, apiSecret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    sub: apiKey,
    nbf: now,
    iat: now,
    exp: now + SERVICE_TOKEN_TTL_SECONDS,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", apiSecret).update(signingInput).digest();
  return `${signingInput}.${signature.toString("base64url")}`;
}
