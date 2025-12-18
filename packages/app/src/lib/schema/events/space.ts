/**
 * Space-level events: join, leave, admin management, handle linking
 */

import { did, didStream, didUser, type } from "../primitives";

// Join a Roomy space (only valid in user's personal stream)
export const spaceJoin = type({
  $type: "'space.roomy.space.join.v0'",
  /** The space being joined */
  spaceId: didStream,
});

// Leave a Roomy space (only valid in user's personal stream)
export const spaceLeave = type({
  $type: "'space.roomy.space.leave.v0'",
  /** The space being left */
  spaceId: didStream,
});

// Add an admin to the space
export const adminAdd = type({
  $type: "'space.roomy.admin.add.v0'",
  /** DID of the user being made admin */
  userId: didUser,
});

// Remove an admin from the space
export const adminRemove = type({
  $type: "'space.roomy.admin.remove.v0'",
  /** DID of the user being removed as admin */
  userId: didUser,
});

/**
 * Set the ATProto account DID for the space handle.
 *
 * For verification, the ATProto account must also have a
 * `space.roomy.stream` PDS record with rkey `handle` pointing
 * back to this stream's ID.
 */
export const streamHandleAccount = type({
  $type: "'space.roomy.stream.handleAccount.v0'",
  /** The ATProto DID, or null to unset */
  "did?": did,
});

// All space events
export const spaceEvent = spaceJoin
  .or(spaceLeave)
  .or(adminAdd)
  .or(adminRemove)
  .or(streamHandleAccount);

// Export for registry
export const events = {
  "space.roomy.space.join.v0": {
    type: spaceJoin,
    description: "Join a Roomy space (tracked in user's personal stream)",
  },
  "space.roomy.space.leave.v0": {
    type: spaceLeave,
    description: "Leave a Roomy space",
  },
  "space.roomy.admin.add.v0": {
    type: adminAdd,
    description: "Add an admin to the space",
  },
  "space.roomy.admin.remove.v0": {
    type: adminRemove,
    description: "Remove an admin from the space",
  },
  "space.roomy.stream.handleAccount.v0": {
    type: streamHandleAccount,
    description: "Set the ATProto account for the space's handle",
  },
} as const;
