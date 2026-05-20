/**
 * Shared Message schema, used by both `room.getMessages` and
 * `message.getMessage` responses, and by the `#messageDiff` WS frame.
 * Mirrors packages/appserver/src/queries/selectMessages.ts MessageDto.
 */
import { type } from "arktype";

export const Reaction = type({
  emoji: "string",
  dids: "string[]",
  /** reaction_id of the viewer's own reaction for this emoji, or null. */
  "myReactionId": "string | null",
});

export const Media = type({
  url: "string",
  type: "string",
  alt: "string | null",
});

export const ForwardedFrom = type({
  name: "string",
  roomId: "string",
});

export const Message = type({
  id: "string",
  /** Sort index for timeline ordering. ULID based on canonical timestamp. */
  "sort_idx?": "string | null",
  content: "string",
  authorDid: "string",
  authorName: "string",
  authorAvatar: "string | null",
  timestamp: "string",
  replyTo: "string | null",
  forwardedFrom: ForwardedFrom.or("null"),
  reactions: Reaction.array(),
  media: Media.array(),
  tags: "string[]",
});
