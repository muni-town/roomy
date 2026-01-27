/**
 * User events: metadata overrides (for bridged accounts) and read tracking
 */

import { BasicInfoUpdate, Did, StreamDid, type, Ulid } from "../primitives";
import {
  defineEvent,
  sql,
  ensureEntity,
  decodeTime,
  type SqlStatement,
} from "./index";

const SetUserProfileSchema = type({
  $type: "'space.roomy.user.updateProfile.v0'",
  did: Did.describe("The DID of the user to set the profile for."),
  // isn't specifying the did a bit of an edge case, only really for bridging or weird admin actions?
  // in which case it seems better to be an extension...
  "extensions?": type.Record(type.string, type.unknown),
})
  .and(BasicInfoUpdate)
  .describe(
    "Set a user profile. \
This can be used to update the profile info of bridged accounts. \
It can also be used by a user to set a space-specific profile.",
  );

export const SetUserProfile = defineEvent(
  SetUserProfileSchema,
  ({ streamId, event }) => {
    const updates = [
      { key: "name", value: event.name },
      { key: "avatar", value: event.avatar },
      { key: "description", value: event.description },
    ];
    const setUpdates = updates.filter((x) => x.value !== undefined);

    const statements: (SqlStatement | undefined)[] = [
      ensureEntity(streamId, event.did),
      setUpdates.length > 0
        ? {
            sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
            params: Object.fromEntries([
              [":entity", event.did],
              ...setUpdates.map((x) => [
                ":" + x.key,
                "value" in x ? x.value : undefined,
              ]),
            ]),
          }
        : undefined,
    ];

    // Extract handle from Discord extension if present
    const discordOrigin = event.extensions?.[
      "space.roomy.extension.discordUserOrigin.v0"
    ] as { handle?: string } | undefined;
    if (discordOrigin?.handle) {
      statements.push(
        sql`
          INSERT INTO comp_user (did, handle)
          VALUES (${event.did}, ${discordOrigin.handle})
          ON CONFLICT(did) DO UPDATE SET handle = ${discordOrigin.handle}
        `,
      );
    }

    return statements.filter((x) => !!x);
  },
);

const SetLastReadSchema = type({
  $type: "'space.roomy.space.personal.setLastRead.v0'",
  streamDid: StreamDid.describe("The stream containing the room"),
  roomId: Ulid.describe("The room being marked as read"),
}).describe(
  "Mark a room as read. \
Sent to the user's personal stream to track when they last visited a room. \
The event's ULID timestamp encodes when the room was read.",
);

export const SetLastRead = defineEvent(SetLastReadSchema, ({ event }) => {
  // Extract timestamp from the event's ULID
  const timestamp = decodeTime(event.id);

  return [
    // Ensure the room entity exists in the target stream
    // Note: we use event.streamDid here, not the wrapper's streamId
    ensureEntity(event.streamDid, event.roomId),
    // Insert or update the last read timestamp
    sql`
        insert into comp_last_read (entity, timestamp, unread_count)
        values (${event.roomId}, ${timestamp}, 0)
        on conflict(entity) do update set
          timestamp = excluded.timestamp,
          updated_at = excluded.timestamp,
          unread_count = excluded.unread_count
      `,
  ];
});

// All user events
export const UserEventVariant = type.or(
  SetUserProfileSchema,
  SetLastReadSchema,
);
