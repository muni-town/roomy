/**
 * Schema for `space.roomy.room.getThreads` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getThreads.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.getThreads" as const;

export const Params = type({ roomId: "string" });

export const ThreadMember = type({
  did: "string",
  "name?": "string",
  "avatar?": "string",
});

export const ThreadActivity = type({
  "latestTimestamp?": "string",
  latestMembers: ThreadMember.array(),
});

export const RoomThread = type({
  id: "string",
  "name?": "string",
  "canonicalParent?": "string",
  activity: ThreadActivity,
});

export const Response = type({
  threads: RoomThread.array(),
});
