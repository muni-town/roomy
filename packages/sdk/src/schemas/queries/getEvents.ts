/**
 * Schema for `space.roomy.sync.getEvents` (query).
 * Admin-only: fetches raw stream events for a space by cursor.
 */
import { type } from "arktype";

export const NSID = "space.roomy.sync.getEvents" as const;

/** Params. `cursor` is the last-seen stream index (exclusive). */
export const Params = type({
  streamDid: "string",
  "cursor?": "string",
  "limit?": "string",
});

/** A single encoded stream event. */
export const StreamEvent = type({
  idx: "number",
  user: "string",
  payload: type({ $bytes: "string.base64" }),
});

export const Response = type({
  events: StreamEvent.array(),
  cursor: "number",
});
