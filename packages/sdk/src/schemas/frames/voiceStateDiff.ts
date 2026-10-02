/**
 * Schema for the `#voiceStateDiff` WS frame body.
 * Sent server → client over `space.roomy.sync.subscribe`, one frame per
 * connection subscribed to the room's topic.
 *
 * Source of truth: packages/appserver/src/sync/handler.ts (#routeVoiceStateDiff)
 * and packages/appserver/src/invalidation/types.ts (VoiceStateDiff signal).
 *
 * Header is `{ op: 1, t: "#voiceStateDiff" }`.
 *
 * A participant's mute/deafen flags changed. This state is ephemeral by
 * design: it is never a durable fact, never a repo record, and not retained
 * across reconnects — a client that missed a frame re-reads nothing, because
 * the next `space.roomy.voice.join` re-establishes the flags.
 */
import { type } from "arktype";

export const T = "#voiceStateDiff" as const;

export const Body = type({
  roomId: "string",
  did: "string",
  muted: "boolean",
  deafened: "boolean",
});
