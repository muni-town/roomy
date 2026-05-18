/**
 * Schema for `space.roomy.room.getThreads` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getThreads.ts
 *
 * Same nullability adjustments as getSpaceThreads (name and latestTimestamp
 * are nullable in practice).
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.getThreads" as const;

export const Params = type({ roomId: "string" });

export const ThreadMember = type({
  did: "string",
  name: "string | null",
  avatar: "string | null",
});

export const ThreadActivity = type({
  latestTimestamp: "string | null",
  latestMembers: ThreadMember.array(),
});

export const RoomThread = type({
  id: "string",
  name: "string | null",
  canonicalParent: "string | null",
  activity: ThreadActivity,
});

export const Response = type({
  threads: RoomThread.array(),
});
