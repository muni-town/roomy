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

export const JoinSpace = type({
  $type: "'space.roomy.space.joinSpace.v0'",
  spaceDid: StreamDid.describe("The space being joined."),
}).describe(
  "Join a Roomy space. \
This must be sent in the space itself, announcing that you have joined.",
);

export const PersonalJoinSpace = type({
  $type: "'space.roomy.space.personal.joinSpace.v0'",
  spaceDid: StreamDid.describe("The space being joined."),
}).describe(
  "Join a Roomy space. \
This must be sent in a user's personal stream and is how you update the joined spaces list. \
Signaling that you have joined a space inside the space you are joining should be done with a room.joinRoom event.",
);

export const LeaveSpace = type({
  $type: "'space.roomy.space.personal.leaveSpace.v0'",
  spaceDid: StreamDid.describe("The space being left."),
}).describe(
  "Leave a Roomy space. \
This must be sent in a user's personal stream and is how you update the joined spaces list.",
);

export const UpdateSpaceInfo = type({
  $type: "'space.roomy.space.updateSpaceInfo.v0'",
})
  .and(BasicInfoUpdate)
  .describe(
    "Update a space's basic info. \
This is used to set things like the name, icon, and description for a space.",
  );

export const UpdateSidebar = type({
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

export const AddAdmin = type({
  $type: "'space.roomy.space.addAdmin.v0'",
  userDid: UserDid.describe("The user to add as an admin."),
}).describe("Add an admin to the space");

export const RemoveAdmin = type({
  $type: "'space.roomy.space.removeAdmin.v0'",
  userDid: UserDid.describe("The user to remove as an admin."),
}).describe("Remove an admin from the space");

export const SetHandleAccount = type({
  $type: "'space.roomy.stream.setHandleAccount.v0'",
  did: Did.or(type.null).describe("The ATProto DID, or null to unset."),
}).describe(
  "Set the ATProto account DID for the space handle. \
For verification, the ATProto account must also have a `space.roomy.stream` PDS record with rkey `handle` pointing back to this stream's ID.",
);

// All space events
export const SpaceEventVariant = type.or(
  JoinSpace,
  PersonalJoinSpace,
  LeaveSpace,
  AddAdmin,
  RemoveAdmin,
  SetHandleAccount,
  UpdateSpaceInfo,
);
