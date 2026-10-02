/**
 * LiveKit webhook ingestion.
 *
 * LiveKit is the authority on media state: a `participant_joined` means a
 * media connection is established, which user intent alone cannot claim. Each
 * event becomes a durable call fact, collapsed against the projection, so the
 * webhook confirms or corrects what the client already recorded rather than
 * appending a second history.
 *
 * Events are routed by the `@{callId}` suffix of the room name. A webhook can
 * arrive after the appserver has moved on to a new call in the same Roomy room
 * — LiveKit retries, and a room's teardown is asynchronous — and the suffix is
 * what lets such an event be attributed to the generation it belongs to and
 * dropped when that generation is gone.
 */

import type { DbLike } from "../db/types.ts";
import { openSpaceDb } from "../db/db.ts";
import { log } from "../log.ts";
import { isMember } from "../auth/access.ts";
import { getLiveKit } from "./livekit.ts";
import { resolveRoomName, verifyLiveKitWebhook } from "./tokens.ts";
import { recordCallEnded, recordJoin, recordLeave } from "./callFacts.ts";

/** The subset of LiveKit's webhook payload the call pipeline reads. */
export interface LiveKitWebhookPayload {
  event: string;
  room?: { name?: string };
  participant?: { identity?: string };
}

/**
 * Identities that are not participants.
 *
 * A native companion publisher (a desktop app capturing game video) joins with
 * its own opaque LiveKit identity and must not appear in a Roomy participant
 * list. The appserver mints no such tokens today; the filter exists so the
 * companion phase cannot start counting them by accident.
 */
const NON_PARTICIPANT_IDENTITY_PREFIX = "companion:";

/**
 * Handle a verified webhook payload. Idempotent for every event type.
 *
 * A participant identity must be a member of the space: LiveKit will connect
 * anyone holding a token, and a token is only minted for a member, but the
 * identity in a webhook is LiveKit's to report. Checking membership here is
 * what keeps a departure from a since-removed member's lingering connection —
 * or a token minted before they were removed — from writing call facts for
 * someone the space no longer includes.
 */
export async function handleLiveKitWebhook(
  payload: LiveKitWebhookPayload,
  deps: { openSpaceDb?: (spaceId: string) => DbLike } = {},
): Promise<void> {
  const config = getLiveKit();
  if (!config) return;

  const roomName = payload.room?.name;
  if (typeof roomName !== "string") return;
  const resolved = resolveRoomName(roomName, config.serverId);
  if (!resolved) {
    // Another deployment's room on a shared LiveKit project, or a name this
    // appserver did not mint. Ignoring it is the only safe reading.
    return;
  }

  const spaceDb = (deps.openSpaceDb ?? openSpaceDb)(resolved.spaceId);
  const identity = payload.participant?.identity;

  switch (payload.event) {
    case "participant_joined": {
      if (!identity || isNonParticipant(identity)) return;
      if (!(await isMember(spaceDb, resolved.spaceId, identity))) return;
      await recordJoin(
        spaceDb,
        {
          did: identity,
          spaceId: resolved.spaceId,
          roomId: resolved.roomId,
          callId: resolved.callId,
        },
        "livekit",
      );
      return;
    }

    case "participant_left": {
      if (!identity || isNonParticipant(identity)) return;
      await recordLeave(
        spaceDb,
        {
          did: identity,
          spaceId: resolved.spaceId,
          roomId: resolved.roomId,
          callId: resolved.callId,
        },
        "livekit",
      );
      return;
    }

    case "room_finished": {
      await recordCallEnded(
        spaceDb,
        {
          did: config.apiKey,
          spaceId: resolved.spaceId,
          roomId: resolved.roomId,
          callId: resolved.callId,
        },
        "livekit",
      );
      return;
    }

    default:
      // Track and egress events are not call-state transitions; the media
      // pipeline owns them.
      return;
  }
}

/** True for identities the participant list must not show. */
function isNonParticipant(identity: string): boolean {
  return identity.startsWith(NON_PARTICIPANT_IDENTITY_PREFIX);
}

export interface LiveKitWebhookRequest {
  authorization: string | null;
  body: Buffer;
}

export interface LiveKitWebhookOutcome {
  status: number;
  error?: string;
}

/**
 * Validate and ingest one webhook request.
 *
 * Validation comes first and completely: an unsigned or mis-signed request is
 * rejected before its body is parsed, so a forged payload never reaches the
 * call-fact pipeline.
 */
export async function processLiveKitWebhook(
  request: LiveKitWebhookRequest,
  deps: { openSpaceDb?: (spaceId: string) => DbLike } = {},
): Promise<LiveKitWebhookOutcome> {
  const config = getLiveKit();
  if (!config) {
    return { status: 503, error: "LiveKit is not configured" };
  }
  if (!verifyLiveKitWebhook(config, request.authorization, request.body)) {
    return { status: 401, error: "Invalid webhook signature" };
  }

  let payload: LiveKitWebhookPayload;
  try {
    payload = JSON.parse(request.body.toString("utf8")) as LiveKitWebhookPayload;
  } catch {
    return { status: 400, error: "Malformed webhook body" };
  }

  try {
    await handleLiveKitWebhook(payload, deps);
  } catch (err) {
    // 500 asks LiveKit to retry: a fact that failed to write is not a fact
    // that may be dropped, and the write is idempotent when it is retried.
    log.error(
      `[voice] webhook handling failed for ${payload.event}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { status: 500, error: "Webhook handling failed" };
  }
  return { status: 200 };
}
