/**
 * Schema for `space.roomy.room.getThreads` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getThreads.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.getThreads" as const;

export const Params = type({ roomId: "string" });

export const ThreadMember = type({
  did: "string",
  "name?": "string | null",
  "avatar?": "string | null",
});


export const ThreadMessage = type({
  id: "string",
  content: "string",
  author: ThreadMember,
  "timestamp?": "string",
});

export const ThreadActivity = type({
  "latestTimestamp?": "string",
  latestMembers: ThreadMember.array(),
  "latestMessage?": ThreadMessage,
});

export const RoomThread = type({
  id: "string",
  "name?": "string",
  "canonicalParent?": "string",
  "unreadCount?": "number",
  activity: ThreadActivity,
});

export const Response = type({
  threads: RoomThread.array(),
});
