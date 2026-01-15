/**
 * Room events: create, delete, join, leave, member management
 */

import { UserDid, type, Ulid, BasicInfo, BasicInfoUpdate } from "../primitives";
import { RoomExtensionMap } from "../extensions/room";
import { defineEvent, sql, ensureEntity } from "./index";

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

const CreateRoomSchema = type({
  $type: "'space.roomy.room.createRoom.v0'",
  kind: RoomKind,
  "extensions?": RoomExtensionMap,
})
  .and(BasicInfo)
  .describe(
    "Create a room. The ulid of this event becomes the id of the room.",
  );

export const CreateRoom = defineEvent(
  CreateRoomSchema,
  ({ streamId, event }) => [
    ensureEntity(streamId, event.id),
    sql`
      insert into comp_info ( entity, name, avatar, description)
      values ( ${event.id}, ${event.name || null}, ${event.avatar || null}, ${event.description || null})
      on conflict do nothing
    `,
    sql`
      insert into comp_room ( entity, label )
      values ( ${event.id}, ${event.kind} ) on conflict do nothing
    `,
  ],
);

const UpdateRoomSchema = type({
  $type: "'space.roomy.room.updateRoom.v0'",
  roomId: Ulid.describe("The room to update"),
  "kind?": RoomKind.or(type.null),
})
  .and(BasicInfoUpdate)
  .describe(
    "Allows you to set the room kind, basic information, or to change it's parent",
  );

export const UpdateRoom = defineEvent(UpdateRoomSchema, ({ event }) => {
  const updates = [
    { key: "name", value: event.name },
    { key: "avatar", value: event.avatar },
    { key: "description", value: event.description },
  ];
  const setUpdates = updates.filter((x) => x.value !== undefined);

  return [
    // Update the room kind
    event.kind !== undefined
      ? sql`
          update comp_room set label = ${event.kind} where entity = ${event.roomId}
          `
      : undefined,

    // Update the room info
    setUpdates.length > 0
      ? {
          sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
          params: Object.fromEntries([
            [":entity", event.roomId],
            ...setUpdates.map((x) => [
              ":" + x.key,
              "value" in x ? x.value : undefined,
            ]),
          ]),
        }
      : undefined,
  ].filter((x) => !!x);
});

const DeleteRoomSchema = type({
  $type: "'space.roomy.room.deleteRoom.v0'",
  roomId: Ulid.describe("The room to delete"),
}).describe("Delete a room. Sent at top level or in the parent room.");

export const DeleteRoom = defineEvent(DeleteRoomSchema, ({ event }) => {
  return [
    sql`
        update comp_room
        set deleted = 1
        where entity = ${event.roomId}
      `,
  ];
});

// All room events
export const RoomEventVariant = type.or(
  CreateRoomSchema,
  DeleteRoomSchema,
  UpdateRoomSchema,
);
