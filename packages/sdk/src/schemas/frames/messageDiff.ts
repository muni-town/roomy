/**
 * Schema for the `#messageDiff` WS frame body.
 * Sent server → client over `space.roomy.sync.subscribe`.
 * Source of truth: packages/appserver/src/sync/handler.ts (#routeMessageDiff)
 * and packages/appserver/src/invalidation/types.ts (MessageDiff signal).
 *
 * Header is `{ op: 1, t: "#messageDiff" }` — encoded separately as the first
 * CBOR value of the frame.
 */
import { type } from "arktype";
import { Message } from "../queries/_message";

export const T = "#messageDiff" as const;

export const Op = type({
  op: "'add' | 'update' | 'remove'",
  key: "string",
  "message?": Message,
});
export type Op = typeof Op.infer;

export const Body = type({
  roomId: "string",
  seq: "number",
  ops: Op.array(),
});
export type Body = typeof Body.infer;
