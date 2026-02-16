/**
 * Link events: create and remove room links
 */

import { sql } from "../../utils/sqlTemplate";
import { type, Ulid } from "../primitives";
import { defineEvent } from "./utils";

const CreateRoomLinkSchema = type({
  $type: "'space.roomy.link.createRoomLink.v0'",
  linkToRoom: Ulid.describe("The room to link."),
  "isCreationLink?": "boolean", // Whether this link is being created as part of the creation of the linked room
}).describe("Inside a room, link to another room.");

export const CreateRoomLink = defineEvent(
  CreateRoomLinkSchema,
  ({ streamId, event, user }) => {
    return [
      sql`
          insert or replace into edges (head, tail, label, payload)
          values (
            ${event.room},
            ${event.linkToRoom},
            'link',
            json_object('canonical_parent', (
              SELECT COUNT(*) = 0
              FROM edges
              WHERE head = ${event.room}
                AND tail = ${event.linkToRoom}
                AND label = 'link'
            ))
          )
        `,
      // create system message announcing the link
      sql`
        insert into entities (id, stream_id, room)
        values (
          ${event.id},
          ${streamId},
          ${event.room}
        ) on conflict do nothing
      `,
      sql`
          insert or replace into edges (head, tail, label)
          select
            ${event.id},
            ${streamId},
            'author'
        `,
      // 'linked to' is probably not what we want, but this is not a user facing affordance for now
      sql`
        insert or replace into comp_content (entity, mime_type, data, last_edit)
        values (
          ${event.id},
          'text/markdown',
          cast(('[@' || (select handle from comp_user where did = ${user}) || '](/user/' || ${user} || ') ' || ${event.isCreationLink ? "created [" : "linked to ["} || (select name from comp_info where entity = ${event.linkToRoom}) || '](' || ${event.linkToRoom} || '?parent=' || ${event.room} || ').') as blob),
          ${event.id}
      )
      `,
    ];
  },
);

const RemoveRoomLinkSchema = type({
  $type: "'space.roomy.link.removeRoomLink.v0'",
  linkToRoom: Ulid.describe("The room to unlink."),
}).describe("Inside a room, unlink from another room.");

export const RemoveRoomLink = defineEvent(
  RemoveRoomLinkSchema,
  // TODO: implement removeRoomLink materializer
  ({}) => {
    return [];
  },
);

export const LinkEventVariant = CreateRoomLinkSchema.or(RemoveRoomLinkSchema);
