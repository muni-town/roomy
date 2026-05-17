/**
 * Schema for the client → server WS messages over `space.roomy.sync.subscribe`.
 * These are JSON-encoded text frames (not CBOR).
 * Source of truth: packages/appserver/src/xrpc/types.ts (ClientMessage).
 */
import { type } from "arktype";

export const Sub = type({
  type: "'sub'",
  topic: "'space' | 'room'",
  id: "string",
});
export type Sub = typeof Sub.infer;

export const Unsub = type({
  type: "'unsub'",
  topic: "'space' | 'room'",
  id: "string",
});
export type Unsub = typeof Unsub.infer;

export const Cursor = type({
  type: "'cursor'",
  seq: "number",
});
export type Cursor = typeof Cursor.infer;

export const ClientMessage = Sub.or(Unsub).or(Cursor);
export type ClientMessage = typeof ClientMessage.infer;
