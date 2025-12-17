/**
 * Space-level events: join, leave, admin management, handle linking
 */

import { type, hash } from "../primitives";

// Join a Roomy space (used in user's personal stream)
export const spaceJoin = type({
  $type: "'space.roomy.event.space.join'",
  /** The space being joined */
  spaceId: hash,
});

// Leave a Roomy space
export const spaceLeave = type({
  $type: "'space.roomy.event.space.leave'",
  /** The space being left */
  spaceId: hash,
});

// Add an admin to the space
export const adminAdd = type({
  $type: "'space.roomy.event.admin.add'",
  /** DID of the user being made admin */
  adminId: "string",
});

// Remove an admin from the space
export const adminRemove = type({
  $type: "'space.roomy.event.admin.remove'",
  /** DID of the user being removed as admin */
  adminId: "string",
});

/**
 * Set the ATProto account DID for the space handle.
 *
 * For verification, the ATProto account must also have a
 * `space.roomy.stream` PDS record with rkey `handle` pointing
 * back to this stream's ID.
 */
export const streamHandleAccount = type({
  $type: "'space.roomy.event.stream.handleAccount'",
  /** The ATProto DID, or null to unset */
  "did?": "string",
});

// All space events
export const spaceEvent = spaceJoin
  .or(spaceLeave)
  .or(adminAdd)
  .or(adminRemove)
  .or(streamHandleAccount);

// Export for registry
export const events = {
  "space.roomy.event.space.join": {
    type: spaceJoin,
    description: "Join a Roomy space (tracked in user's personal stream)",
  },
  "space.roomy.event.space.leave": {
    type: spaceLeave,
    description: "Leave a Roomy space",
  },
  "space.roomy.event.admin.add": {
    type: adminAdd,
    description: "Add an admin to the space",
  },
  "space.roomy.event.admin.remove": {
    type: adminRemove,
    description: "Remove an admin from the space",
  },
  "space.roomy.event.stream.handleAccount": {
    type: streamHandleAccount,
    description: "Set the ATProto account for the space's handle",
  },
} as const;
