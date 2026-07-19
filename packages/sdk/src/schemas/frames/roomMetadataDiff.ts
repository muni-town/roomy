/**
 * Schema for the `#roomMetadataDiff` WS frame body.
 * Sent server → client over `space.roomy.sync.subscribe`, one frame per
 * affected user (not a broadcast — each user's connection gets its own frame).
 *
 * Source of truth: packages/appserver/src/sync/handler.ts (#routeRoomMetadataDiff)
 * and packages/appserver/src/invalidation/types.ts (RoomMetadataDiff signal).
 *
 * Header is `{ op: 1, t: "#roomMetadataDiff" }` — encoded separately as the first
 * CBOR value of the frame.
 *
 * The client patches three cache entries from this frame, avoiding refetches:
 *   - `space.roomy.room.getMetadata` → `unreadCount += delta`
 *   - `space.roomy.space.getSpaces`   → the matching space's `unreadCount += delta`
 *   - `space.roomy.space.getMetadata` → the channel entry in the sidebar tree
 *
 * `delta` is the unread-count increment (`+1` per message). The client adds it
 * to the cached `unreadCount` rather than replacing the absolute value, so the
 * server never needs to read the current count.
 *
 * `seq` is a per-connection monotonic counter the client uses to detect gaps
 * (missed frames) and force a refetch — mirrors `#messageDiff.seq`.
 */
import { type } from "arktype";

export const T = "#roomMetadataDiff" as const;

export const Body = type({
  spaceId: "string",
  roomId: "string",
  delta: "number",
  seq: "number",
});