/**
 * Schema for `space.roomy.message.getReactions` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.message.getReactions.ts
 *
 * Returns the list of reactors grouped by emoji for a single message.
 * Called on hover/tooltip — not part of the message DTO.
 */
import { type } from "arktype";

export const NSID = "space.roomy.message.getReactions" as const;

export const Params = type({ messageId: "string" });

export const ReactorInfo = type({
  did: "string",
  name: "string",
  "handle?": "string",
  "avatar?": "string",
});

export const ReactionGroup = type({
  emoji: "string",
  reactors: ReactorInfo.array(),
});

export const Response = type({
  reactions: ReactionGroup.array(),
});
