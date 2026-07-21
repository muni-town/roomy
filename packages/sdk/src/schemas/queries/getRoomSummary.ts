/**
 * Schema for `space.roomy.room.getRoomSummary` (query).
 *
 * Lightweight read of a room's display fields (name, kind, spaceId) only —
 * no recent threads, no read positions, no unread counts. Intended for
 * link-badge enrichment where a rendered message references a room by DID
 * and the client only needs enough to render a label (and a thread/channel
 * icon).
 *
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getRoomSummary.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.getRoomSummary" as const;

export const Params = type({ roomId: "string" });

export const Response = type({
  "name?": "string",
  kind: "string",
  spaceId: "string",
});