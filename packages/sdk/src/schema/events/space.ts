/**
 * Space-level events: join, leave, admin management, handle linking
 */

import {
  BasicInfoUpdate,
  Did,
  StreamDid,
  Ulid,
  UserDid,
  type,
} from "../primitives";
import { defineEvent, sql, ensureEntity, edgePayload } from "./index";

const JoinSpaceSchema = type({
  $type: "'space.roomy.space.joinSpace.v0'",
}).describe(
  "Join a Roomy space. \
This must be sent in the space itself, announcing that you have joined. \
If accepted by the space this will add you to the member list.",
);

export const JoinSpace = defineEvent(
  JoinSpaceSchema,
  ({ streamId, user, event }) => [
    sql`
      insert or replace into edges (head, tail, label, payload)
      values (
        ${streamId},
        ${user},
        'member',
        ${edgePayload({
          can: "post",
        })}
      )
    `,
    // Create a system message announcing the member joining
    sql`
      insert into entities (id, stream_id, room)
      values (
        ${event.id},
        ${streamId},
        (
          select entity
            from comp_room join entities e on e.id = entity
            where label = 'space.roomy.channel' and deleted = 0 and e.stream_id = ${streamId}
            order by entity
            limit 1
        )
      ) on conflict do nothing
    `,
    // Set author on the system message to be the stream itself
    sql`
        insert or replace into edges (head, tail, label)
        select
          ${event.id},
          ${streamId},
          'author'
      `,
    sql`
      insert or replace into comp_content (entity, mime_type, data, last_edit)
      values (
        ${event.id},
        'text/markdown',
        cast(('[@' || (select handle from comp_user where did = ${user}) || '](/user/' || ${user} || ') joined the space.') as blob),
        ${event.id}
    )`,
  ],
);

const LeaveSpaceSchema = type({
  $type: "'space.roomy.space.leaveSpace.v0'",
}).describe(
  "Leave a Roomy space. \
This must be sent in the space itself, announcing that you have left. \
This will remove you from the member list.",
);

export const LeaveSpace = defineEvent(
  LeaveSpaceSchema,
  ({ streamId, user }) => [
    sql`
      delete from edges
      where
        head = ${streamId}
          and
        tail = ${user}
          and
        label = 'member'
    `,
  ],
);

const PersonalJoinSpaceSchema = type({
  $type: "'space.roomy.space.personal.joinSpace.v0'",
  spaceDid: StreamDid.describe("The space being joined."),
}).describe(
  "Join a Roomy space. \
This must be sent in a user's personal stream and is how you update the joined spaces list. \
Signaling that you have joined a space inside the space you are joining should be done with a room.joinRoom event.",
);

export const PersonalJoinSpace = defineEvent(
  PersonalJoinSpaceSchema,
  ({ streamId, event }) => {
    return [
      ensureEntity(streamId, event.spaceDid),
      sql`
        insert into comp_space (entity)
        values (${event.spaceDid})
        on conflict do update set hidden = 0
      `,
    ];
  },
);

const PersonalLeaveSpaceSchema = type({
  $type: "'space.roomy.space.personal.leaveSpace.v0'",
  spaceDid: StreamDid.describe("The space being left."),
}).describe(
  "Leave a Roomy space. \
This must be sent in a user's personal stream and is how you update the joined spaces list.",
);

export const PersonalLeaveSpace = defineEvent(
  PersonalLeaveSpaceSchema,
  ({ event }) => [
    sql`
      delete from comp_space where entity = ${event.spaceDid}
    `,
  ],
);

const UpdateSpaceInfoSchema = type({
  $type: "'space.roomy.space.updateSpaceInfo.v0'",
})
  .and(BasicInfoUpdate)
  .describe(
    "Update a space's basic info. \
This is used to set things like the name, icon, and description for a space.",
  );

export const UpdateSpaceInfo = defineEvent(
  UpdateSpaceInfoSchema,
  ({ streamId, event }) => {
    const updates = [
      { key: "name", value: event.name },
      { key: "avatar", value: event.avatar },
      { key: "description", value: event.description },
    ];
    const setUpdates = updates.filter((x) => x.value !== undefined);

    return [
      ensureEntity(streamId, event.id),
      setUpdates.length > 0
        ? {
            sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
            params: Object.fromEntries([
              [":entity", streamId],
              ...setUpdates.map((x) => [
                ":" + x.key,
                "value" in x ? x.value : undefined,
              ]),
            ]),
          }
        : undefined,
    ].filter((x) => !!x);
  },
);

const UpdateSidebarSchema = type({
  $type: "'space.roomy.space.updateSidebar.v0'",
  categories: type({
    name: "string",
    children: Ulid.array(),
  })
    .array()
    .describe(
      "An ordered array of 'category objects', \
      each with a name and a list of children expected to be Room IDs",
    ),
}).describe(
  "Overwrite the sidebar categories and their children for a space. \
    Must be updated if new channels are to be added to the sidebar. \
    The order of elements in the array must be overwritten to be changed.",
);

export const UpdateSidebar = defineEvent(
  UpdateSidebarSchema,
  ({ streamId, event }) => {
    const configJson = { categories: event.categories };
    const config = JSON.stringify(configJson);
    return [
      sql`
      update comp_space
      set sidebar_config = ${config}
      where entity = ${streamId}
    `,
    ];
  },
);

const AddAdminSchema = type({
  $type: "'space.roomy.space.addAdmin.v0'",
  userDid: UserDid.describe("The user to add as an admin."),
}).describe("Add an admin to the space");

export const AddAdmin = defineEvent(AddAdminSchema, ({ streamId, event }) => {
  return [
    sql`
      insert or replace into edges (head, tail, label, payload)
      values (
        ${streamId},
        ${event.userDid},
        'member',
        ${edgePayload({
          can: "admin",
        })}
      )
    `,
  ];
});

const RemoveAdminSchema = type({
  $type: "'space.roomy.space.removeAdmin.v0'",
  userDid: UserDid.describe("The user to remove as an admin."),
}).describe("Remove an admin from the space");

export const RemoveAdmin = defineEvent(
  RemoveAdminSchema,
  ({ streamId, event }) => [
    sql`
      update edges set payload = (${JSON.stringify({ can: "post" })})
      where
        head = ${streamId}
          and
        tail = ${event.userDid}
          and
        label = 'member'
    `,
  ],
);

const SetHandleAccountSchema = type({
  $type: "'space.roomy.space.setHandleAccount.v0'",
  did: Did.or(type.null).describe("The ATProto DID, or null to unset."),
}).describe(
  "Set the ATProto account DID for the space handle. \
For verification, the ATProto account must also have a `space.roomy.stream` PDS record with rkey `handle` pointing back to this stream's ID.",
);

export const SetHandleAccount = defineEvent(
  SetHandleAccountSchema,
  ({ streamId, event }) => [
    sql`
      update comp_space set handle_account = ${event.did || null}
      where entity = ${streamId}
    `,
  ],
);

// All space events
export const SpaceEventVariant = type.or(
  JoinSpaceSchema,
  LeaveSpaceSchema,
  PersonalJoinSpaceSchema,
  PersonalLeaveSpaceSchema,
  AddAdminSchema,
  RemoveAdminSchema,
  SetHandleAccountSchema,
  UpdateSpaceInfoSchema,
  UpdateSidebarSchema,
);
