/**
 * Role events: create, delete, member assignment, room permission management
 */

import { UserDid, Ulid, type, BasicInfo, BasicInfoUpdate } from "../primitives";
import { defineEvent } from "./utils";
import { sql } from "../../utils";

const CreateRoleSchema = type({
  $type: "'space.roomy.role.createRole.v0'",
})
  .and(BasicInfo)
  .describe(
    "Create a role in the space. The ULID of this event becomes the role's ID.",
  );

export const CreateRole = defineEvent(
  CreateRoleSchema,
  ({ event, streamId }) => [
    sql`
    insert or ignore into roles (id, stream_id, name, avatar, description)
    values (${event.id}, ${streamId}, ${event.name || null}, ${event.avatar || null}, ${event.description || null})
  `,
  ],
);

const UpdateRoleSchema = type({
  $type: "'space.roomy.role.updateRole.v0'",
  roleId: Ulid.describe("The role to update."),
})
  .and(BasicInfoUpdate)
  .describe("Update a role's name, description, or avatar.");

export const UpdateRole = defineEvent(UpdateRoleSchema, ({ event }) => {
  const updates = [
    { key: "name", value: event.name },
    { key: "avatar", value: event.avatar },
    { key: "description", value: event.description },
  ];
  const setUpdates = updates.filter((x) => x.value !== undefined);

  if (setUpdates.length === 0) return [];

  return [
    {
      sql: `update roles set ${setUpdates.map((x) => `${x.key} = :${x.key}`).join(", ")} where id = :roleId`,
      params: Object.fromEntries([
        [":roleId", event.roleId],
        ...setUpdates.map((x) => [":" + x.key, x.value ?? null]),
      ]),
    },
  ];
});

const DeleteRoleSchema = type({
  $type: "'space.roomy.role.deleteRole.v0'",
  roleId: Ulid.describe("The ID of the role to delete."),
}).describe("Soft-delete a role from the space.");

export const DeleteRole = defineEvent(DeleteRoleSchema, ({ event }) => [
  sql`
    update roles set deleted = 1 where id = ${event.roleId}
  `,
]);

const AddMemberRoleSchema = type({
  $type: "'space.roomy.role.addMemberRole.v0'",
  userDid: UserDid.describe("The member to assign to the role."),
  roleId: Ulid.describe("The role to assign."),
}).describe("Assign a role to a space member.");

export const AddMemberRole = defineEvent(
  AddMemberRoleSchema,
  ({ event, streamId }) => [
    sql`
    insert or ignore into member_roles (user_id, role_id, stream_id)
    values (${event.userDid}, ${event.roleId}, ${streamId})
  `,
  ],
);

const RemoveMemberRoleSchema = type({
  $type: "'space.roomy.role.removeMemberRole.v0'",
  userDid: UserDid.describe("The member to remove from the role."),
  roleId: Ulid.describe("The role to remove."),
}).describe("Remove a role from a space member.");

export const RemoveMemberRole = defineEvent(
  RemoveMemberRoleSchema,
  ({ event }) => [
    sql`
      delete from member_roles
      where user_id = ${event.userDid} and role_id = ${event.roleId}
    `,
  ],
);

const SetRoleRoomPermissionSchema = type({
  $type: "'space.roomy.role.setRoleRoomPermission.v0'",
  roleId: Ulid.describe("The role to update."),
  roomId: Ulid.describe("The room to set permissions for."),
  permission: type("'read' | 'readwrite'")
    .or(type.null)
    .describe(
      "The permission level. null removes the role's access to the room.",
    ),
}).describe(
  "Set a role's permission level for a room. " +
    "Pass null to remove the role's access to the room.",
);

export const SetRoleRoomPermission = defineEvent(
  SetRoleRoomPermissionSchema,
  ({ event, streamId }) => [
    // Remove existing entry unconditionally first, then re-insert if non-null.
    sql`
      delete from role_rooms
      where role_id = ${event.roleId} and room_id = ${event.roomId}
    `,
    ...(event.permission !== null
      ? [
          sql`
            insert into role_rooms (role_id, room_id, stream_id, permission)
            values (${event.roleId}, ${event.roomId}, ${streamId}, ${event.permission})
          `,
        ]
      : []),
  ],
);

export const RoleEventVariant = type.or(
  CreateRoleSchema,
  DeleteRoleSchema,
  UpdateRoleSchema,
  AddMemberRoleSchema,
  RemoveMemberRoleSchema,
  SetRoleRoomPermissionSchema,
);
