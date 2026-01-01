/**
 * Room events: create, delete, join, leave, member management
 */

import { UserDid, type, Ulid, BasicInfo, BasicInfoUpdate } from "../primitives";

export const RoomKind = type(
  "'space.roomy.channel' | 'space.roomy.category' | 'space.roomy.thread' | 'space.roomy.page'",
).describe("A kind of room, such as a channel, thread, or page.");
export type RoomKind = typeof RoomKind.infer;

// Access level for room members
export const AccessLevel = type("'read' | 'write'").describe(
  "The access level, either read or write.",
);

export const GroupMember = type
  .or(
    type({
      $type: "'space.roomy.member.anonymous.v0'",
    }).describe("All users who have not authenticated"),
    type({
      $type: "'space.roomy.member.authenticated.v0'",
    }).describe("All users that have authenticated themselves."),
    type({
      $type: "'space.roomy.member.user.v0'",
      did: UserDid.describe("The DID of the user."),
    }).describe("A user with a specific DID"),
    type({
      $type: "'space.roomy.member.room.v0'",
      roomId: Ulid.describe("The ID of the room"),
    }).describe(
      "Another room to use as a group. That room's member list will be used.",
    ),
  )
  .describe("The group member identifier");

export const CreateRoom = type({
  $type: "'space.roomy.room.createRoom.v0'",
  kind: RoomKind,
})
  .and(BasicInfo)
  .describe(
    "Create a room. \
This can be sent at the space level ( no room ), or in parent room. \
The ulid of this event becomes the id of the room.",
  );

export const MoveTo = type({
  $type: "'space.roomy.room.move.v0'",
  "toRoom?": Ulid.or(type.null).describe(
    "The new parent room, or null if you want to parent to the space.",
  ),
  "after?": Ulid.describe(
    "If specified, sorts the item immediately after another item in \
the new room or the current room if there is no new room. \
If not specified, or if the ID in `after` does not exist, then the event \
will be sorted at the end of the room. \
Note: Some materializers will wait to materialize the event until the event \
in after is found, so if it does not exist, this event may not be materialized.",
  ),
}).describe(
  "Move an item in the room to another room and/or change it's sort order.",
);

export const UpdateRoom = type({
  $type: "'space.roomy.room.updateRoom.v0'",
  "kind?": RoomKind.or(type.null),
})
  .and(BasicInfoUpdate)
  .describe(
    "Allows you to set the room kind, basic information, or to change it's parent",
  );

export const DeleteRoom = type({
  $type: "'space.roomy.room.deleteRoom.v0'",
  roomId: Ulid.describe("The room to delete"),
}).describe("Delete a room. Sent at top level or in the parent room.");

export const JoinRoom = type({
  $type: "'space.roomy.room.joinRoom.v0'",
}).describe(
  "Join the room specified in envelope. If no room specified, the event is an announcement on joining a space.",
);

export const LeaveRoom = type({
  $type: "'space.roomy.room.leaveRoom.v0'",
}).describe("Leave a room");

export const AddMember = type({
  $type: "'space.roomy.room.addMember.v0'",
  member: GroupMember,
  access: AccessLevel,
}).describe("Add a member to the room's access list");

export const UpdateMember = type({
  $type: "'space.roomy.room.updateMember.v0'",
  member: GroupMember,
  access: AccessLevel,
  "reason?": "string",
}).describe("Change a room member's access permissions");

export const RemoveMember = type({
  $type: "'space.roomy.room.removeMember.v0'",
  member: GroupMember,
  access: AccessLevel,
  "reason?": "string",
}).describe("Remove a member from the room's access list");

// All room events
export const RoomEvent = type.or(
  CreateRoom,
  DeleteRoom,
  JoinRoom,
  LeaveRoom,
  MoveTo,
  UpdateRoom,
  AddMember,
  UpdateMember,
  RemoveMember,
);
