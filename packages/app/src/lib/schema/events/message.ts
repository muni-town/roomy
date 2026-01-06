/**
 * Message events: create, edit, delete, move, reorder
 */

import { type, Ulid, Content } from "../primitives";
import {
  MessageExtensionMap,
  MessageExtensionUpdateMap,
} from "../extensions/message";
import { setDependsOn } from "./dependencies";

export const CreateMessage = type({
  $type: "'space.roomy.message.createMessage.v0'",
  body: Content.describe(
    "The main content of the chat message. Usually this uses the text/markdown mime type.",
  ),
  extensions: MessageExtensionMap,
}).describe("Create a new message.");

export const EditMessage = type({
  $type: "'space.roomy.message.editMessage.v0'",
  messageId: Ulid.describe("ID of message being edited."),
  "previous?": Ulid.describe("ID of edit event directly preceding this one."),
  body: Content.describe(
    "New content. \
If mimeType is text/x-dmp-diff, this is a diff-match-patch diff to apply to the previous content.",
  ),
  "extensions?": MessageExtensionUpdateMap,
}).describe("Edit a previously sent message.");

setDependsOn("space.roomy.message.editMessage.v0", {
  events: (x) => (x.previous ? [x.previous, x.messageId] : [x.messageId]),
});

export const DeleteMessage = type({
  $type: "'space.roomy.message.deleteMessage.v0'",
  messageId: Ulid.describe("The ID of the message being deleted."),
  "reason?": "string",
}).describe("Delete a message.");

setDependsOn("space.roomy.message.deleteMessage.v0", {
  events: (x) => [x.messageId],
});

export const MoveMessage = type({
  $type: "'space.roomy.message.moveMessage.v0'",
  messageId: Ulid.describe("The ID of the message being moved."),
  roomId: Ulid.describe("The room to which the message should be moved"),
}).describe("Move a message to a different room");

setDependsOn("space.roomy.message.moveMessage.v0", {
  events: (x) => [x.messageId],
});

export const ReorderMessage = type({
  $type: "'space.roomy.message.reorderMessage.v0'",
  messageId: Ulid.describe("The ID of the message being moved."),
  after: Ulid.describe(
    "The ID of the message that should directly precede this one",
  ),
}).describe("Reorder a message in a room's timeline");

setDependsOn("space.roomy.message.reorderMessage.v0", {
  events: (x) => [x.messageId],
});

// All message events
export const MessageEventVariant = type.or(
  CreateMessage,
  EditMessage,
  DeleteMessage,
  MoveMessage,
  ReorderMessage,
);
