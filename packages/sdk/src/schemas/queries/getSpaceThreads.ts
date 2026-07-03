/**
 * Schema for `space.roomy.space.getThreads` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getThreads.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getThreads" as const;

export const Params = type({ spaceId: "string" });

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

export const Thread = type({
  id: "string",
  "name?": "string",
  "channel?": "string",
  "channelName?": "string",
  "unreadCount?": "number",
  activity: ThreadActivity,
});

export const Response = type({
  threads: Thread.array(),
});
