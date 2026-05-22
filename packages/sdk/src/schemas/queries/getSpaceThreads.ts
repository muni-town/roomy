/**
 * Schema for `space.roomy.space.getThreads` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getThreads.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getThreads" as const;

export const Params = type({ spaceId: "string" });

export const ThreadMember = type({
  did: "string",
  "name?": "string",
  "avatar?": "string",
});

export const ThreadActivity = type({
  "latestTimestamp?": "string",
  latestMembers: ThreadMember.array(),
});

export const Thread = type({
  id: "string",
  "name?": "string",
  "channel?": "string",
  activity: ThreadActivity,
});

export const Response = type({
  threads: Thread.array(),
});
