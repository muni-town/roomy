import { type, Ulid } from "../primitives";

export const CreateRoomLink = type({
  $type: "'space.roomy.link.createRoomLink.v0'",
  room: Ulid.describe("The room to link."),
}).describe("Inside a room, link to another room.");

export const RemoveRoomLink = type({
  $type: "'space.roomy.link.removeRoomLink.v0'",
  room: Ulid.describe("The room to unlink."),
}).describe("Inside a room, unlink from another room.");

export const LinkEventVariant = CreateRoomLink.or(RemoveRoomLink);
