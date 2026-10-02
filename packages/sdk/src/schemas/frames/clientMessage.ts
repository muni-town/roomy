/**
 * Schema for the client → server WS messages over `space.roomy.sync.subscribe`.
 * These are JSON-encoded text frames (not CBOR).
 * Source of truth: packages/appserver/src/xrpc/types.ts (ClientMessage).
 */
import { type } from "arktype";

export const Sub = type({
  type: "'sub'",
  topic: "'space' | 'room' | 'mentions'",
  id: "string",
});

export const Unsub = type({
  type: "'unsub'",
  topic: "'space' | 'room' | 'mentions'",
  id: "string",
});

export const Cursor = type({
  type: "'cursor'",
  seq: "number",
});

/**
 * Ephemeral voice state, scoped to one room's call. Never persisted: the
 * server broadcasts it to the room's topic and drops it. Sent only while
 * connected to that room's call.
 */
export const VoiceState = type({
  type: "'voice_state'",
  roomId: "string",
  muted: "boolean",
  deafened: "boolean",
});

export const ClientMessage = Sub.or(Unsub).or(Cursor).or(VoiceState);
