/**
 * Schema for the `#voicePresenceDiff` WS frame body.
 * Sent server → client over `space.roomy.sync.subscribe`, one frame per
 * connection subscribed to the room's topic.
 *
 * Source of truth: packages/appserver/src/sync/handler.ts
 * (#routeVoicePresenceDiff) and packages/appserver/src/invalidation/types.ts
 * (VoicePresenceDiff signal).
 *
 * Header is `{ op: 1, t: "#voicePresenceDiff" }` — encoded separately as the
 * first CBOR value of the frame.
 *
 * A participant joined or left a room's call. The frame carries only the
 * transition; the client patches its cached `getParticipants` entry. `callId`
 * is the generation the transition belongs to, so a client holding a different
 * (stale) callId ignores the frame and refetches instead of patching a list
 * that no longer describes the same call.
 *
 * `callEnded` carries no participant, because the call it names has no
 * participants left.
 */
import { type } from "arktype";

export const T = "#voicePresenceDiff" as const;

export const Body = type({
  roomId: "string",
  callId: "string",
  op: "'join' | 'leave' | 'callEnded'",
  /** Absent for `callEnded` — no single participant is the subject. */
  "did?": "string",
  /** Which path produced the transition, so a client can distinguish its own
   *  optimistic join from the SFU's confirmation. */
  "source?": "'user' | 'livekit' | 'reconciliation'",
});
