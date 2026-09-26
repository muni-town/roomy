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

export const Body = type({
  roomId: "string",
  /**
   * Per-connection monotonic counter, assigned by the server when the frame
   * is delivered (not when the change is emitted). Delivery is selective, so
   * stamping at delivery is what makes the seqs a connection receives
   * contiguous — the client reads a gap as "I missed frames".
   */
  seq: "number",
  ops: Op.array(),
});
