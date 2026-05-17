/**
 * Shared Message schema, used by both `room.getMessages` and
 * `message.getMessage` responses, and by the `#messageDiff` WS frame.
 * Mirrors packages/appserver/src/queries/selectMessages.ts MessageDto.
 */
import { type } from "arktype";

export const Reaction = type({
  emoji: "string",
  dids: "string[]",
});
export type Reaction = typeof Reaction.infer;

export const Media = type({
  url: "string",
  type: "string",
  alt: "string | null",
});
export type Media = typeof Media.infer;

export const ForwardedFrom = type({
  name: "string",
  roomId: "string",
});
export type ForwardedFrom = typeof ForwardedFrom.infer;

export const Message = type({
  id: "string",
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
export type Message = typeof Message.infer;
