/**
 * Space-level events: join, leave, admin management, handle linking
 */

import { Did, StreamDid, UserDid, type } from "../primitives";

// Join a Roomy space (only valid in user's personal stream)
export const spaceJoin = type({
  $type: "'space.roomy.personal.joinSpace.v0'",
  /** The space being joined */
  spaceId: StreamDid,
});

// Leave a Roomy space (only valid in user's personal stream)
export const spaceLeave = type({
  $type: "'space.roomy.personal.leaveSpace.v0'",
  /** The space being left */
  spaceId: StreamDid,
});

// Add an admin to the space
export const adminAdd = type({
  $type: "'space.roomy.space.addAdmin.v0'",
  /** DID of the user being made admin */
  userId: UserDid,
});

// Remove an admin from the space
export const adminRemove = type({
  $type: "'space.roomy.space.removeAdmin.v0'",
  /** DID of the user being removed as admin */
  userId: UserDid,
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
  "did?": Did,
});

// All space events
export const spaceEvent = spaceJoin
  .or(spaceLeave)
  .or(adminAdd)
  .or(adminRemove)
  .or(streamHandleAccount);

// Export for registry
export const events = {
  "space.roomy.personal.joinSpace.v0": {
    type: spaceJoin,
    description: "Join a Roomy space (tracked in user's personal stream)",
  },
  "space.roomy.personal.leaveSpace.v0": {
    type: spaceLeave,
    description: "Leave a Roomy space",
  },
  "space.roomy.space.addAdmin.v0": {
    type: adminAdd,
    description: "Add an admin to the space",
  },
  "space.roomy.space.removeAdmin.v0": {
    type: adminRemove,
    description: "Remove an admin from the space",
  },
  "space.roomy.stream.handleAccount.v0": {
    type: streamHandleAccount,
    description: "Set the ATProto account for the space's handle",
  },
} as const;
