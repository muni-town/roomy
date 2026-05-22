/**
 * Schema for `space.roomy.room.getMessages` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getMessages.ts
 * and packages/appserver/src/queries/selectMessages.ts (MessageDto).
 */
import { type } from "arktype";
import { Message } from "./_message";

export const NSID = "space.roomy.room.getMessages" as const;

export const Params = type({
  roomId: "string",
  "limit?": "string",
  "cursor?": "string",
});

export { Message };

export const Response = type({
  messages: Message.array(),
  "cursor?": "string",
});
