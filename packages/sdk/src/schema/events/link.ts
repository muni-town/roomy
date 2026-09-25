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
      // Idempotent: the canonical_parent payload ("first link wins") is
      // computed from the current edge count, so re-applying the same
      // createRoomLink would otherwise flip 1 → 0 and corrupt the thread's
      // parent channel. `on conflict do nothing` makes re-materialisation
      // safe — the first write establishes the payload and later writes
      // (re-backfill, replay) leave it untouched. `insert or replace` would
      // instead re-evaluate the subquery each pass, so its second pass sees
      // the row from the first and sets canonical_parent to 0.
      sql`
          insert into edges (head, tail, label, payload)
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
          on conflict (head, tail, label) do nothing
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
          insert or ignore into edges (head, tail, label)
          select
            ${event.id},
            ${streamId},
            'author'
        `,
      // 'linked to' is probably not what we want, but this is not a user facing affordance for now
      //
      // The user label is stored as their DID (deterministic at materialisation
      // time — the acting user may have no profile row yet, e.g. the Discord
      // bridge bot). The appserver resolves the DID to a display name/handle at
      // read time from the global profile store, so we never bake a missing or
      // stale handle into the stored message.
      sql`
        insert or replace into comp_content (entity, mime_type, data, last_edit)
        values (
          ${event.id},
          'text/markdown',
          cast(('[@' || ${user} || '](/user/' || ${user} || ') ' || ${event.isCreationLink ? "created [" : "linked to ["} || coalesce((select name from comp_info where entity = ${event.linkToRoom}), 'this room') || '](' || ${event.linkToRoom} || '?parent=' || ${event.room} || ').') as blob),
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
  ({ event: { room, linkToRoom } }) => {
    return [
      sql`
        delete from edges
        where
          label = 'link'
            and
          head = ${room}
            and
          tail = ${linkToRoom}
      `,
    ];
  },
);

export const LinkEventVariant = CreateRoomLinkSchema.or(RemoveRoomLinkSchema);
