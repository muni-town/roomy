/**
 * Schema for `space.roomy.space.getThreads` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getThreads.ts
 *
 * Note: appserver returns `name: string | null` and `latestTimestamp: string | null`
 * (also `latestMembers[].name: string | null`), while the playground's
 * hand-authored types declared them as non-null. We follow the appserver.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getThreads" as const;

export const Params = type({ spaceId: "string" });
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

export const Thread = type({
  id: "string",
  name: "string | null",
  channel: "string | null",
  activity: ThreadActivity,
});
export type Thread = typeof Thread.infer;

export const Response = type({
  threads: Thread.array(),
});
export type Response = typeof Response.infer;
