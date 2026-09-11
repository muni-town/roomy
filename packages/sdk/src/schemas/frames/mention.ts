/**
 * Schema for the `#mention` WS frame body.
 * Sent server → client over `space.roomy.sync.subscribe` when a message
 * mentions a DID the connection is subscribed to (`mentions:<did>` topic).
 *
 * Header is `{ op: 1, t: "#mention" }` — encoded separately as the first
 * CBOR value of the frame.
 *
 * Source of truth: packages/appserver/src/sync/handler.ts (#routeMentionDiff)
 * and packages/appserver/src/invalidation/types.ts (MentionDiff signal).
 */
import { type } from "arktype";
import { Message } from "../queries/_message";

export const T = "#mention" as const;

export const Op = type({
  op: "'add' | 'update' | 'remove'",
  key: "string",
  "message?": Message,
  // Present on add/update ops: 'mention' (plain #didMention) or 'reply'
  // (depth-1 reply to this DID's message). Remove ops carry no kind.
  "kind?": "'mention' | 'reply'",
});

export const Body = type({
  /** The mentioned user's DID. */
  did: "string",
  spaceId: "string",
  roomId: "string",
  seq: "number",
  ops: Op.array(),
});
