/**
 * Space-level events: join, leave, admin management, handle linking
 */

import { BasicInfoUpdate, Did, StreamDid, UserDid, type } from "../primitives";

export const JoinSpace = type({
  $type: "'space.roomy.stream.personal.joinSpace.v0'",
  spaceDid: StreamDid.configure("The space being joined."),
}).describe(
  "Join a Roomy space. \
This must be sent in a user's personal stream and is how you update the joined spaces list. \
Signaling that you have joined a space inside the space you are joining should be done with a room.joinRoom event.",
);

export const LeaveSpace = type({
  $type: "'space.roomy.stream.personal.leaveSpace.v0'",
  spaceDid: StreamDid.configure("The space being left."),
}).configure(
  "Leave a Roomy space. \
This must be sent in a user's personal stream and is how you update the joined spaces list.",
);

export const UpdateStreamInfo = type({
  $type: "'space.roomy.stream.updateStreamInfo.v0'",
})
  .and(BasicInfoUpdate)
  .describe(
    "Update a stream's basic info. \
This is used to set things like the name, icon, and description for a space.",
  );

export const AddAdmin = type({
  $type: "'space.roomy.stream.addAdmin.v0'",
  userDid: UserDid.describe("The user to add as an admin."),
}).configure("Add an admin to the space");

export const RemoveAdmin = type({
  $type: "'space.roomy.stream.removeAdmin.v0'",
  userDid: UserDid.describe("The user to remove as an admin."),
}).configure("Remove an admin from the space");

export const SetHandleAccount = type({
  $type: "'space.roomy.stream.setHandleAccount.v0'",
  did: Did.or(type.null).describe("The ATProto DID, or null to unset."),
}).configure(
  "Set the ATProto account DID for the space handle. \
For verification, the ATProto account must also have a `space.roomy.stream` PDS record with rkey `handle` pointing back to this stream's ID.",
);

// All space events
export const SpaceEvent = type.or(
  JoinSpace,
  LeaveSpace,
  AddAdmin,
  RemoveAdmin,
  SetHandleAccount,
  UpdateStreamInfo,
);
