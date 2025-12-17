/**
 * User events: metadata overrides (for bridged accounts) and read tracking
 */

import { type, ulid, hash } from "../primitives";

/**
 * Override user metadata.
 * Primarily used for bridged accounts (e.g. Discord) where we can't
 * retrieve the handle from the ID.
 */
export const userOverrideMeta = type({
  $type: "'space.roomy.event.user.overrideMeta'",
  /** The original handle from the bridged platform */
  handle: "string",
});

/**
 * Mark a room as read.
 * Sent to the user's personal stream to track when they last visited a room.
 * The event's ULID timestamp encodes when the room was read.
 */
export const roomLastRead = type({
  $type: "'space.roomy.event.room.lastRead'",
  /** The room being marked as read */
  roomId: ulid,
  /** The stream containing the room */
  streamId: hash,
});

// All user events
export const userEvent = userOverrideMeta.or(roomLastRead);

// Export for registry
export const events = {
  "space.roomy.event.user.overrideMeta": {
    type: userOverrideMeta,
    description: "Override user metadata for bridged accounts",
  },
  "space.roomy.event.room.lastRead": {
    type: roomLastRead,
    description: "Mark a room as read (tracked in user's personal stream)",
  },
} as const;
