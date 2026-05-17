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
export type Params = typeof Params.infer;

export const ThreadMember = type({
  did: "string",
  name: "string | null",
  avatar: "string | null",
});
export type ThreadMember = typeof ThreadMember.infer;

export const ThreadActivity = type({
  latestTimestamp: "string | null",
  latestMembers: ThreadMember.array(),
});
export type ThreadActivity = typeof ThreadActivity.infer;

export const RoomThread = type({
  id: "string",
  name: "string | null",
  canonicalParent: "string | null",
  activity: ThreadActivity,
});
export type RoomThread = typeof RoomThread.infer;

export const Response = type({
  threads: RoomThread.array(),
});
export type Response = typeof Response.infer;
