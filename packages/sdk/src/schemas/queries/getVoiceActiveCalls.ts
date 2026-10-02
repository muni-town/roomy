/**
 * Schema for `space.roomy.voice.getActiveCalls` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.voice.getActiveCalls.ts
 *
 * Space-scoped: the rooms in one space that currently have a call, so the
 * sidebar can mark them. Scoped to a single space rather than global because
 * the caller's access is resolved per space, and a global list would have to
 * filter every entry by membership anyway.
 *
 * When LiveKit is unconfigured this returns an empty list, not an error — a
 * deployment without voice renders no call affordances rather than failing.
 */
import { type } from "arktype";

export const NSID = "space.roomy.voice.getActiveCalls" as const;

export const Params = type({ spaceId: "string" });

export const ActiveCall = type({
  roomId: "string",
  callId: "string",
  /** Canonical call start, ms since epoch (the callStarted event's ULID). */
  startedAt: "number",
  participantCount: "number",
});

export const Response = type({
  calls: ActiveCall.array(),
});
