/**
 * User events: metadata overrides (for bridged accounts) and read tracking
 */

import { BasicInfoUpdate, Did, StreamDid, type, Ulid } from "../primitives";

export const SetUserProfile = type({
  $type: "'space.roomy.user.updateProfile.v0'",
  did: Did.describe("The DID of the user to set the profile for."),
})
  .and(BasicInfoUpdate)
  .describe(
    "Set a user profile. \
This can be used to update the profile info of bridged accounts. \
It can also be used by a user to set a space-specific profile.",
  );

export const OverrideUserHandle = type({
  $type: "'space.roomy.user.overrideHandle.v0'",
  did: Did.describe("The DID of the user to override the info for"),
  handle: type.string.describe("The original handle from the bridged platform"),
}).describe(
  "Override user metadata in this space. \
Primarily used for bridged accounts (e.g. Discord) where we can't retrieve the handle from the ID.",
);

export const SetLastRead = type({
  $type: "'space.roomy.space.personal.setLastRead.v0'",
  streamDid: StreamDid.describe("The stream containing the room"),
  roomId: Ulid.describe("The room being marked as read"),
}).describe(
  "Mark a room as read. \
Sent to the user's personal stream to track when they last visited a room. \
The event's ULID timestamp encodes when the room was read.",
);

// All user events
export const UserEventVariant = type.or(
  SetUserProfile,
  OverrideUserHandle,
  SetLastRead,
);
