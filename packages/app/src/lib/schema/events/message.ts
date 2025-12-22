/**
 * Message events: create, edit, delete
 */

import { type, Ulid, Content, UserDid, Timestamp } from "../primitives";
import { messageExtension } from "../extensions/message";

// Create a new message
export const messageCreate = type({
  $type: "'space.roomy.room.sendMessage.v1'",
  body: Content,
  /** Extensible fields: replies, attachments, overrides */
  extensions: messageExtension.array(),
});

// Edit an existing message
export const messageEdit = type({
  $type: "'space.roomy.room.editMessage.v0'",
  /** Id of message being edited */
  target: Ulid,
  /** Id of last known edit event, or the message itself */
  parent: Ulid,
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

// Change the author or timestamp of a native message. Intended for bridge puppeting.
export const messageOverrideMeta = type({
  $type: "'space.roomy.message.overrideMeta.v0'",
  author: UserDid,
  timestamp: Timestamp,
});

// All message events
export const messageEvent = messageCreate
  .or(messageEdit)
  .or(messageDelete)
  .or(messageOverrideMeta);

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
  "space.roomy.message.overrideMeta.v0": {
    type: messageOverrideMeta,
    description:
      "Change the author or timestamp of a native message. Intended for bridge puppeting.",
  },
} as const;
