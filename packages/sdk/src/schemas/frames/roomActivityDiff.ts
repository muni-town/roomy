/**
 * Schema for the `#roomActivityDiff` WS frame body.
 * Sent server → client over `space.roomy.sync.subscribe`, one frame per
 * subscribed connection (a broadcast — the fields are identical for every
 * reader, unlike `#roomMetadataDiff` which is sent per affected user).
 *
 * Source of truth: packages/appserver/src/sync/handler.ts
 * (#routeRoomActivityDiff) and packages/appserver/src/invalidation/types.ts
 * (RoomActivityDiff signal).
 *
 * Header is `{ op: 1, t: "#roomActivityDiff" }` — encoded separately as the
 * first CBOR value of the frame.
 *
 * A message just landed in `roomId` and is now that room's latest activity, so
 * the activity-ordered views move: the boards
 * (`space.roomy.space.getThreads`, `space.roomy.room.getThreads`). The client
 * upserts this row and moves it to the front, instead of refetching each board
 * per message.
 *
 * The frame carries no caller-scoped field: unread counts ride on
 * `#roomMetadataDiff`, which knows the per-user delta.
 */
import { type } from "arktype";

export const T = "#roomActivityDiff" as const;

export const ActivityMember = type({
  did: "string",
  name: "string | null",
  avatar: "string | null",
});

export const ActivityMessage = type({
  id: "string",
  content: "string",
  author: ActivityMember,
  "timestamp?": "string",
});

export const Body = type({
  spaceId: "string",
  roomId: "string",
  kind: "'thread' | 'channel'",
  "name?": "string",
  "parentChannelId?": "string",
  "parentChannelName?": "string",
  activity: {
    "latestTimestamp?": "string",
    /**
     * The participants this message added — the author. The board's real list
     * is the room's newest 3 distinct authors, so the client merges this into
     * the cached list (dedupe by DID, cap 3) rather than replacing it.
     */
    latestMembers: ActivityMember.array(),
    "latestMessage?": ActivityMessage,
  },
});
