/**
 * Room events: create, delete, join, leave, member management
 */

import { didUser, type, ulid } from "../primitives";

// Room kinds (replaces the mark/unmark pattern)
export const roomKind = type("'channel' | 'category' | 'thread' | 'page'");

// Access level for room members
export const accessLevel = type("'read' | 'write'");

// Group member identifier
export const groupMember = type({
  /** Anyone, including unauthenticated users */
  $type: "'space.roomy.member.anonymous.v0'",
})
  .or({
    /** Authenticated users that have joined the space. */
    $type: "'space.roomy.member.authenticated.v0'",
  })
  .or({
    $type: "'space.roomy.member.user.v0'",
    /** A user ID. */
    id: didUser,
  })
  .or({
    $type: "'space.roomy.member.room.v0'",
    /** The ID of another room to use as a group. That room's member list will be used. */
    roomId: ulid,
  });

// Create a room. Sent at top level (no room), or in parent room. The ulid of this event becomes the id of the room.
export const roomCreate = type({
  $type: "'space.roomy.room.createRoom.v0'",
});

// Delete a room. Sent at top level or in parent room.
export const roomDelete = type({
  $type: "'space.roomy.room.deleteRoom.v0'",
  roomId: ulid, // the room to delete
});

// Join a room. Author joins the room specified in envelope. If no room specified, the event is an announcement on joining a space.
export const roomJoin = type({
  $type: "'space.roomy.room.joinRoom.v0'",
});

// Leave a room
export const roomLeave = type({
  $type: "'space.roomy.room.leave.v0'",
});

// Set room kind
export const roomSetKind = type({
  $type: "'space.roomy.room.setKind.v0'",
  kind: roomKind,
});

// Update room parent
export const roomUpdateParent = type({
  $type: "'space.roomy.room.updateParent.v0'",
  "parent?": ulid,
});

// Add a member to a room
export const roomMemberAdd = type({
  $type: "'space.roomy.room.addMember.v0'",
  member: groupMember,
  access: accessLevel,
});

export const roomMemberUpdate = type({
  $type: "'space.roomy.room.updateMember.v0'",
  member: groupMember,
  access: accessLevel,
  "reason?": "string",
});

// Remove a member from a room
export const roomMemberRemove = type({
  $type: "'space.roomy.room.removeMember.v0'",
  member: groupMember,
  access: accessLevel,
  "reason?": "string",
});

// All room events
export const roomEvent = roomCreate
  .or(roomDelete)
  .or(roomJoin)
  .or(roomLeave)
  .or(roomSetKind)
  .or(roomUpdateParent)
  .or(roomMemberAdd)
  .or(roomMemberUpdate)
  .or(roomMemberRemove);

// Export for registry
export const events = {
  "space.roomy.room.createRoom.v0": {
    type: roomCreate,
    description:
      "Create a new room. Sub-rooms are created by sending this in another room.",
  },
  "space.roomy.room.deleteRoom.v0": {
    type: roomDelete,
    description: "Delete a room",
  },
  "space.roomy.room.joinRoom.v0": {
    type: roomJoin,
    description:
      "Join the room specified in envelope. If no room specified, the event is an announcement on joining a space.",
  },
  "space.roomy.room.leave.v0": {
    type: roomLeave,
    description: "Leave a room",
  },
  "space.roomy.room.setKind.v0": {
    type: roomSetKind,
    description: "Set the kind of a room (channel, category, thread, or page)",
  },
  "space.roomy.room.updateParent.v0": {
    type: roomUpdateParent,
    description: "Change the parent of a room",
  },
  "space.roomy.room.addMember.v0": {
    type: roomMemberAdd,
    description: "Add a member to the room's access list",
  },
  "space.roomy.room.updateMember.v0": {
    type: roomMemberUpdate,
    description: "Change a room member's access permissions",
  },
  "space.roomy.room.removeMember.v0": {
    type: roomMemberRemove,
    description: "Remove a member from the room's access list",
  },
} as const;
