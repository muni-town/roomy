/**
 * Message operations for Roomy.
 * High-level functions for creating, editing, and deleting messages.
 */

import { newUlid, toBytes, type Ulid } from "../schema";
import type { Event, Attachment } from "../schema";
import type { ConnectedSpace } from "../connection";

/**
 * Options for creating a message.
 */
export interface CreateMessageOptions {
  /** The room ID to send the message to */
  roomId: Ulid;
  /** The message body (plain text or markdown) */
  body: string;
  /** The MIME type of the body (default: text/markdown) */
  mimeType?: string;
  /** Attachments to include with the message */
  attachments?: Attachment[];
  /** Reply-to message ID */
  replyTo?: Ulid;
  /** Author DID (overrides the authenticated user) */
  authorDid?: string;
  /** Author display name (overrides profile) */
  authorName?: string;
  /** Unix timestamp for the message (default: now) */
  timestamp?: number;
  /** Additional extensions to include with the event */
  extensions?: Record<string, unknown>;
}

/**
 * Result of creating a message.
 */
export interface CreateMessageResult {
  /** The ID of the created message */
  id: Ulid;
}

/**
 * Create a message in a room.
 *
 * @param space - The connected space to send the event to
 * @param options - Message creation options
 * @returns The ID of the created message
 *
 * @example
 * ```ts
 * const result = await createMessage(space, {
 *   roomId: "01H...",
 *   body: "Hello, world!",
 *   attachments: [
 *     { $type: "space.roomy.attachment.reply.v0", target: "01J..." }
 *   ]
 * });
 * console.log("Created message:", result.id);
 * ```
 */
export async function createMessage(
  space: ConnectedSpace,
  options: CreateMessageOptions,
): Promise<CreateMessageResult> {
  const messageId = newUlid();

  const extensions: Record<string, unknown> = { ...options.extensions };

  // Add attachments extension if provided
  if (options.attachments && options.attachments.length > 0) {
    extensions["space.roomy.extension.attachments.v0"] = {
      $type: "space.roomy.extension.attachments.v0",
      attachments: options.attachments,
    };
  }

  // Add author override if provided
  if (options.authorDid) {
    extensions["space.roomy.extension.authorOverride.v0"] = {
      $type: "space.roomy.extension.authorOverride.v0",
      did: options.authorDid,
    };
  }

  // Add timestamp override if provided
  if (options.timestamp !== undefined) {
    extensions["space.roomy.extension.timestampOverride.v0"] = {
      $type: "space.roomy.extension.timestampOverride.v0",
      timestamp: options.timestamp,
    };
  }

  // Build attachments array for the event body
  const bodyAttachments: Attachment[] = [];
  if (options.replyTo) {
    bodyAttachments.push({
      $type: "space.roomy.attachment.reply.v0",
      target: options.replyTo,
    });
  }

  const event: Event = {
    id: messageId,
    room: options.roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: options.mimeType || "text/markdown",
      data: toBytes(new TextEncoder().encode(options.body)),
    },
    ...(bodyAttachments.length > 0 ? { attachments: bodyAttachments } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };

  await space.sendEvent(event);

  return { id: messageId };
}

/**
 * Options for editing a message.
 */
export interface EditMessageOptions {
  /** The room containing the message */
  roomId: Ulid;
  /** The ID of the message to edit */
  messageId: Ulid;
  /** The new message body */
  body: string;
  /** The MIME type of the body (default: text/markdown) */
  mimeType?: string;
  /** Unix timestamp for the edit (default: now) */
  timestamp?: number;
}

/**
 * Result of editing a message.
 */
export interface EditMessageResult {
  /** The ID of the edit event */
  id: Ulid;
}

/**
 * Edit a message in a room.
 *
 * @param space - The connected space to send the event to
 * @param options - Message edit options
 * @returns The ID of the edit event
 *
 * @example
 * ```ts
 * const result = await editMessage(space, {
 *   roomId: "01H...",
 *   messageId: "01J...",
 *   body: "Updated message"
 * });
 * ```
 */
export async function editMessage(
  space: ConnectedSpace,
  options: EditMessageOptions,
): Promise<EditMessageResult> {
  const editId = newUlid();

  const extensions: Record<string, unknown> = {};

  if (options.timestamp !== undefined) {
    extensions["space.roomy.extension.timestampOverride.v0"] = {
      $type: "space.roomy.extension.timestampOverride.v0",
      timestamp: options.timestamp,
    };
  }

  const event: Event = {
    id: editId,
    room: options.roomId,
    $type: "space.roomy.message.editMessage.v0",
    message: options.messageId,
    body: {
      mimeType: options.mimeType || "text/markdown",
      data: toBytes(new TextEncoder().encode(options.body)),
    },
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };

  await space.sendEvent(event);

  return { id: editId };
}

/**
 * Options for deleting a message.
 */
export interface DeleteMessageOptions {
  /** The room containing the message */
  roomId: Ulid;
  /** The ID of the message to delete */
  messageId: Ulid;
}

/**
 * Result of deleting a message.
 */
export interface DeleteMessageResult {
  /** The ID of the delete event */
  id: Ulid;
}

/**
 * Delete a message from a room.
 *
 * @param space - The connected space to send the event to
 * @param options - Message delete options
 * @returns The ID of the delete event
 *
 * @example
 * ```ts
 * const result = await deleteMessage(space, {
 *   roomId: "01H...",
 *   messageId: "01J..."
 * });
 * ```
 */
export async function deleteMessage(
  space: ConnectedSpace,
  options: DeleteMessageOptions,
): Promise<DeleteMessageResult> {
  const deleteId = newUlid();

  const event: Event = {
    id: deleteId,
    room: options.roomId,
    $type: "space.roomy.message.deleteMessage.v0",
    messageId: options.messageId,
  };

  await space.sendEvent(event);

  return { id: deleteId };
}

/**
 * Options for reordering a message.
 */
export interface ReorderMessageOptions {
  /** The room containing the message */
  roomId: Ulid;
  /** The ID of the message to reorder */
  messageId: Ulid;
  /** Move the message after this message ID */
  after: Ulid;
}

/**
 * Result of reordering a message.
 */
export interface ReorderMessageResult {
  /** The ID of the reorder event */
  id: Ulid;
}

/**
 * Reorder a message in a room.
 *
 * @param space - The connected space to send the event to
 * @param options - Message reorder options
 * @returns The ID of the reorder event
 *
 * @example
 * ```ts
 * const result = await reorderMessage(space, {
 *   roomId: "01H...",
 *   messageId: "01J...",
 *   after: "01K..."
 * });
 * ```
 */
export async function reorderMessage(
  space: ConnectedSpace,
  options: ReorderMessageOptions,
): Promise<ReorderMessageResult> {
  const reorderId = newUlid();

  const event: Event = {
    id: reorderId,
    room: options.roomId,
    $type: "space.roomy.message.reorderMessage.v0",
    messageId: options.messageId,
    after: options.after,
  };

  await space.sendEvent(event);

  return { id: reorderId };
}

/**
 * Options for forwarding messages.
 */
export interface ForwardMessagesOptions {
  /** The destination room ID */
  roomId: Ulid;
  /** The source room ID */
  fromRoomId: Ulid;
  /** The message IDs to forward */
  messageIds: Ulid[];
}

/**
 * Result of forwarding messages.
 */
export interface ForwardMessagesResult {
  /** The ID of the forward event */
  id: Ulid;
}

/**
 * Forward messages from one room to another (e.g., for threads).
 *
 * @param space - The connected space to send the event to
 * @param options - Message forward options
 * @returns The ID of the forward event
 *
 * @example
 * ```ts
 * const result = await forwardMessages(space, {
 *   roomId: "01H...",  // thread room
 *   fromRoomId: "01J...", // parent channel
 *   messageIds: ["01K...", "01L..."]
 * });
 * ```
 */
export async function forwardMessages(
  space: ConnectedSpace,
  options: ForwardMessagesOptions,
): Promise<ForwardMessagesResult> {
  const forwardId = newUlid();

  const event: Event = {
    id: forwardId,
    room: options.roomId,
    $type: "space.roomy.message.forwardMessages.v0",
    messageIds: options.messageIds,
    fromRoomId: options.fromRoomId,
  };

  await space.sendEvent(event);

  return { id: forwardId };
}
