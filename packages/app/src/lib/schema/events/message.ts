/**
 * Message events: create, edit, delete
 */

import { MessageExtensionMap } from "../extensions/message";
import { type, Ulid, Content } from "../primitives";

// Create a new message
export const messageCreate = type({
  $type: "'space.roomy.room.sendMessage.v0'",
  body: Content,
  /** Extensible fields: replies, attachments, overrides */
  extensions: MessageExtensionMap,
});

// Edit an existing message
export const messageEdit = type({
  $type: "'space.roomy.room.editMessage.v0'",
  /** Id of message being edited */
  target: Ulid,
  /** Id of last known edit event, or the message itself */
  "previous?": Ulid,
  /**
   * New content. If mimeType is text/x-dmp-diff, this is a
   * diff-match-patch diff to apply to the previous content.
   */
  body: Content,
  /** Updated reply target, if changing */
  "replyTo?": Ulid,
});

// Delete a message
export const messageDelete = type({
  $type: "'space.roomy.room.deleteMessage.v0'",
  /** Id of message being deleted */
  target: Ulid,
  "reason?": "string",
});

// All message events
export const messageEvent = messageCreate.or(messageEdit).or(messageDelete);

// Export for registry
export const events = {
  "space.roomy.room.sendMessage.v0": {
    type: messageCreate,
    description:
      "Create a new chat message with optional attachments and metadata",
  },
  "space.roomy.room.editMessage.v0": {
    type: messageEdit,
    description: "Edit a previously sent message",
  },
  "space.roomy.room.deleteMessage.v0": {
    type: messageDelete,
    description: "Delete a message",
  },
} as const;
