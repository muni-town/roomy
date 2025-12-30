/**
 * Message events: create, edit, delete
 */

import { type, Ulid, Content } from "../primitives";
import {
  MessageExtensionMap,
  MessageExtensionUpdateMap,
} from "../extensions/message";

export const CreateMessage = type({
  $type: "'space.roomy.message.sendMessage.v0'",
  body: Content.describe(
    "The main content of the chat message. Usually this uses the text/markdown mime type.",
  ),
  extensions: MessageExtensionMap,
}).describe("Create a new message.");

export const EditMessage = type({
  $type: "'space.roomy.message.editMessage.v0'",
  target: Ulid.configure("Id of message being edited."),
  "previous?": Ulid.configure(
    "Id of last known edit event, or the message itself.",
  ),
  body: Content.describe(
    "New content. \
If mimeType is text/x-dmp-diff, this is a diff-match-patch diff to apply to the previous content.",
  ),
  "extensions?": MessageExtensionUpdateMap,
}).describe("Edit a previously sent message.");

export const DeleteMessage = type({
  $type: "'space.roomy.message.deleteMessage.v0'",
  target: Ulid.describe("The ID of the message being deleted."),
  "reason?": "string",
}).describe("Delete a message.");

// All message events
export const MessageEvent = type.or(CreateMessage, EditMessage, DeleteMessage);
