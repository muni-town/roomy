/**
 * Message events: create, edit, delete
 */

import { type, ulid, content } from "../primitives";
import { messageExtension } from "../extensions/message";

// Create a new message
export const messageCreate = type({
  $type: "'space.roomy.message.create'",
  content,
  /** Extensible fields: replies, attachments, overrides */
  extensions: messageExtension.array(),
});

// Edit an existing message
export const messageEdit = type({
  $type: "'space.roomy.message.edit'",
  /**
   * New content. If mimeType is text/x-dmp-diff, this is a
   * diff-match-patch diff to apply to the previous content.
   */
  content,
  /** Updated reply target, if changing */
  "replyTo?": ulid.or("null"),
});

// Delete a message
export const messageDelete = type({
  $type: "'space.roomy.message.delete'",
  "reason?": "string",
});

// All message events
export const messageEvent = messageCreate.or(messageEdit).or(messageDelete);

// Export for registry
export const events = {
  "space.roomy.message.create": {
    type: messageCreate,
    description:
      "Create a new chat message with optional attachments and metadata",
  },
  "space.roomy.message.edit": {
    type: messageEdit,
    description: "Edit a previously sent message",
  },
  "space.roomy.message.delete": {
    type: messageDelete,
    description: "Delete a message",
  },
} as const;
