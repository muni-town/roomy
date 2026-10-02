/**
 * Schema for `space.roomy.voice.getParticipants` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.voice.getParticipants.ts
 *
 * The projection is the source of truth for who is in a room's call; a client
 * re-reads it on reconnect and after any `#voicePresenceDiff`. `callId` is the
 * generation the list belongs to — a client holding a callId from an earlier
 * generation treats the response as "the call you were in has ended".
 *
 * `callId` is null when the room has no active call, and `participants` is
 * then empty.
 */
import { type } from "arktype";

export const NSID = "space.roomy.voice.getParticipants" as const;

export const Params = type({ roomId: "string" });

export const Participant = type({
  did: "string",
  "joinedAt?": "number",
  /** Which path recorded the participant: explicit intent, the LiveKit
   *  webhook, or the reconciler's correction. */
  source: "'user' | 'livekit' | 'reconciliation'",
});

export const Response = type({
  roomId: "string",
  callId: "string | null",
  participants: Participant.array(),
});
