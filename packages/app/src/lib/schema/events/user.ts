/**
 * User events: metadata overrides (for bridged accounts) and read tracking
 */

import { StreamDid, type, Ulid } from "../primitives";

/**
 * Override user metadata.
 * Primarily used for bridged accounts (e.g. Discord) where we can't
 * retrieve the handle from the ID.
 */
export const userOverrideMeta = type({
  $type: "'space.roomy.space.overrideUserMeta.v0'",
  /** The original handle from the bridged platform */
  handle: "string",
});

/**
 * Mark a room as read.
 * Sent to the user's personal stream to track when they last visited a room.
 * The event's ULID timestamp encodes when the room was read.
 */
export const roomLastRead = type({
  $type: "'space.roomy.room.setLastRead.v0'",
  /** The room being marked as read */
  roomId: Ulid,
  /** The stream containing the room */
  streamId: StreamDid,
});

// All user events
export const userEvent = userOverrideMeta.or(roomLastRead);

// Export for registry
export const events = {
  "space.roomy.space.overrideUserMeta.v0": {
    type: userOverrideMeta,
    description: "Override user metadata for bridged accounts",
  },
  "space.roomy.room.setLastRead.v0": {
    type: roomLastRead,
    description: "Mark a room as read (tracked in user's personal stream)",
  },
} as const;
