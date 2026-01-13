/**
 * User events: metadata overrides (for bridged accounts) and read tracking
 */

import { BasicInfoUpdate, Did, StreamDid, type, Ulid } from "../primitives";
import { defineEvent, sql, ensureEntity, decodeTime } from "./index";

const SetUserProfileSchema = type({
  $type: "'space.roomy.user.updateProfile.v0'",
  did: Did.describe("The DID of the user to set the profile for."),
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

    return [
      ensureEntity(streamId, event.id),
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
    ].filter((x) => !!x);
  },
);

const OverrideUserHandleSchema = type({
  $type: "'space.roomy.user.overrideHandle.v0'",
  did: Did.describe("The DID of the user to override the info for"),
  handle: type.string.describe("The original handle from the bridged platform"),
}).describe(
  "Override user metadata in this space. \
Primarily used for bridged accounts (e.g. Discord) where we can't retrieve the handle from the ID.",
);

export const OverrideUserHandle = defineEvent(
  OverrideUserHandleSchema,
  ({ event }) => {
    return [
      sql`
        insert into comp_user (did, handle)
        values (
          ${event.did},
          ${event.handle}
        )
        on conflict(did) do update set handle = ${event.handle}
      `,
    ];
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
  OverrideUserHandleSchema,
  SetLastReadSchema,
);
