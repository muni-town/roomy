import { type, Ulid } from "../primitives";

const CreateRoomLink = type({
  $type: "'space.roomy.link.createRoomLink.v0'",
  linkToRoom: Ulid.describe("The room to link."),
  "isCreationLink?": "boolean", // Whether this link is being created as part of the creation of the linked room
}).describe("Inside a room, link to another room.");

export const RemoveRoomLink = type({
  $type: "'space.roomy.link.removeRoomLink.v0'",
  linkToRoom: Ulid.describe("The room to unlink."),
}).describe("Inside a room, unlink from another room.");

export const LinkEventVariant = CreateRoomLink.or(RemoveRoomLink);
