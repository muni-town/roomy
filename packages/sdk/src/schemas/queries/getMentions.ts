/**
 * Schema for `space.roomy.mention.getMentions` (query).
 *
 * Returns recent messages that mention a given DID, across all spaces the
 * caller can read. Used for backfill when a client subscribes to the
 * `mentions:<did>` sync topic — the client fetches history via HTTP, then
 * receives live `#mention` frames.
 */
import { type } from "arktype";
import { Message } from "./_message";

export const NSID = "space.roomy.mention.getMentions" as const;

export const Params = type({
  /** The mentioned user's DID. */
  did: "string",
  "limit?": "string",
  "cursor?": "string",
});

/** A mention with enough context to navigate to and reply in the room. */
export const Mention = type({
  message: Message,
  spaceId: "string",
  roomId: "string",
  /** 'mention' (plain #didMention) or 'reply' (depth-1 reply to this DID's message). */
  kind: "'mention' | 'reply'",
});

export const Response = type({
  mentions: Mention.array(),
  "cursor?": "string",
});
