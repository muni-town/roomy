/**
 * Room events: create, delete, join, leave, member management
 */

import { type, ulid } from "../primitives";

// Room kinds (replaces the mark/unmark pattern)
export const roomKind = type("'channel' | 'category' | 'thread' | 'page'");

// Access level for room members
export const accessLevel = type("'read' | 'write'");

// Group member identifier
export const groupMember = type({
  $type: "'space.roomy.member.anonymous'",
})
  .or({
    $type: "'space.roomy.member.authenticated'",
  })
  .or({
    $type: "'space.roomy.member.user'",
    id: "string",
  })
  .or({
    $type: "'space.roomy.member.room'",
    /** Room whose member list to use as a group */
    roomId: ulid,
  });

// Create a room
export const roomCreate = type({
  $type: "'space.roomy.room.create'",
});

// Delete a room
export const roomDelete = type({
  $type: "'space.roomy.room.delete'",
});

// Join a room (author joins the room specified by parent)
export const roomJoin = type({
  $type: "'space.roomy.room.join'",
});

// Leave a room
export const roomLeave = type({
  $type: "'space.roomy.room.leave'",
});

// Set room kind
export const roomSetKind = type({
  $type: "'space.roomy.room.setKind'",
  kind: roomKind,
});

// Update room parent
export const roomUpdateParent = type({
  $type: "'space.roomy.room.updateParent'",
  "parent?": ulid,
});

// Add a member to a room
export const roomMemberAdd = type({
  $type: "'space.roomy.room.member.add'",
  member: groupMember,
  access: accessLevel,
});

// Remove a member from a room
export const roomMemberRemove = type({
  $type: "'space.roomy.room.member.remove'",
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
  .or(roomMemberRemove);

// Export for registry
export const events = {
  "space.roomy.room.create": {
    type: roomCreate,
    description:
      "Create a new room. Sub-rooms are created by sending this in another room.",
  },
  "space.roomy.room.delete": {
    type: roomDelete,
    description: "Delete a room",
  },
  "space.roomy.room.join": {
    type: roomJoin,
    description: "Join the room specified by the event's parent",
  },
  "space.roomy.room.leave": {
    type: roomLeave,
    description: "Leave a room",
  },
  "space.roomy.room.setKind": {
    type: roomSetKind,
    description: "Set the kind of a room (channel, category, thread, or page)",
  },
  "space.roomy.room.updateParent": {
    type: roomUpdateParent,
    description: "Change the parent of a room",
  },
  "space.roomy.room.member.add": {
    type: roomMemberAdd,
    description: "Add a member to the room's access list",
  },
  "space.roomy.room.member.remove": {
    type: roomMemberRemove,
    description: "Remove a member from the room's access list",
  },
} as const;
