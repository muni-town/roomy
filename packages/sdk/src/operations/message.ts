/**
 * Message operations for Roomy.
 * High-level functions for creating, editing, and deleting messages.
 */

import { newUlid, toBytes, type Ulid } from "../schema";
import type { Event, Attachment } from "../schema";
import type { Block } from "../schema/richtext";
import { serializeBlocks } from "../richtext/convert";

/**
 * Options for creating a message.
 */
export interface CreateMessageOptions {
  /** The room ID to send the message to */
  roomId: Ulid;
  /** The message body (plain text or markdown) */
  body: string;
  /** Rich text blocks (serialized as application/vnd.roomy.richtext+json; takes precedence over body) */
  blocks?: Block[];
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
  /** DIDs of users mentioned in the message body */
  mentions?: string[];
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
 * @param options - Message creation options
 * @param sendEvent - Function to send the event
 * @returns The ID of the created message
 *
 * @example
 * ```ts
 * const result = await createMessage({
 *   roomId: "01H...",
 *   body: "Hello, world!",
 *   attachments: [
 *     { $type: "space.roomy.attachment.reply.v0", target: "01J..." }
 *   ]
 * }, sendEvent);
 * console.log("Created message:", result.id);
 * ```
 */
export async function createMessage(
  options: CreateMessageOptions,
  sendEvent: (event: Event) => Promise<void>,
): Promise<CreateMessageResult> {
  const messageId = newUlid();

  // Start with empty extensions map
  const extensions: Record<string, unknown> = {
    ...(options.extensions || {}),
  };

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

  // Add mentions extension if provided (only for legacy string bodies; with
  // `blocks`, mentions fold into #didMention facets in the rich text body)
  if (!options.blocks && options.mentions && options.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: options.mentions,
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

  // Build the event - always include extensions (required by schema)
  const serialized = options.blocks ? serializeBlocks(options.blocks) : null;
  const event: Event = {
    id: messageId,
    room: options.roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: serialized
      ? {
          mimeType: serialized.mimeType,
          data: toBytes(serialized.data),
        }
      : {
          mimeType: options.mimeType || "text/markdown",
          data: toBytes(new TextEncoder().encode(options.body)),
        },
    ...(bodyAttachments.length > 0 ? { attachments: bodyAttachments } : {}),
    extensions,
  };

  await sendEvent(event);

  return { id: messageId };
}

/**
 * Options for editing a message.
 */
export interface EditMessageOptions {
  /** DIDs of users mentioned in the edited message body */
  mentions?: string[];
  /** The room containing the message */
  roomId: Ulid;
  /** The ID of the message to edit */
  messageId: Ulid;
  /** The new message body */
  body: string;
  /** The MIME type of the body (default: text/markdown) */
  mimeType?: string;
  /** Rich text blocks (serialized as application/vnd.roomy.richtext+json; takes precedence over body) */
  blocks?: Block[];
  /** Unix timestamp for the edit (default: now) */
  timestamp?: number;
  /**
   * Attachments to set on the message (via the attachments extension). A
   * link attachment carrying `showPreview: false` removes/dismisses that
   * link embed on the message.
   */
  attachments?: Attachment[];
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
 * @param options - Message edit options
 * @param sendEvent - Function to send the event
 * @returns The ID of the edit event
 *
 * @example
 * ```ts
 * const result = await editMessage({
 *   roomId: "01H...",
 *   messageId: "01J...",
 *   body: "Updated message"
 * }, sendEvent);
 * ```
 */
export async function editMessage(
  options: EditMessageOptions,
  sendEvent: (event: Event) => Promise<void>,
): Promise<EditMessageResult> {
  const editId = newUlid();

  const extensions: Record<string, unknown> = {};

  if (options.timestamp !== undefined) {
    extensions["space.roomy.extension.timestampOverride.v0"] = {
      $type: "space.roomy.extension.timestampOverride.v0",
      timestamp: options.timestamp,
    };
  }
  // Mentions sidecar only for legacy string bodies; with `blocks`, mentions
  // fold into #didMention facets in the rich text body
  if (!options.blocks && options.mentions && options.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: options.mentions,
    };
  }
  // Attachments (e.g. a link attachment with showPreview:false to remove a
  // link embed on the author's own message).
  if (options.attachments && options.attachments.length > 0) {
    extensions["space.roomy.extension.attachments.v0"] = {
      $type: "space.roomy.extension.attachments.v0",
      attachments: options.attachments,
    };
  }

  const serialized = options.blocks ? serializeBlocks(options.blocks) : null;
  const event: Event = {
    id: editId,
    room: options.roomId,
    $type: "space.roomy.message.editMessage.v0",
    messageId: options.messageId,
    body: serialized
      ? {
          mimeType: serialized.mimeType,
          data: toBytes(serialized.data),
        }
      : {
          mimeType: options.mimeType || "text/markdown",
          data: toBytes(new TextEncoder().encode(options.body)),
        },
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };

  await sendEvent(event);

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
 * @param options - Message delete options
 * @param sendEvent - Function to send the event
 * @returns The ID of the delete event
 *
 * @example
 * ```ts
 * const result = await deleteMessage({
 *   roomId: "01H...",
 *   messageId: "01J..."
 * }, sendEvent);
 * ```
 */
export async function deleteMessage(
  options: DeleteMessageOptions,
  sendEvent: (event: Event) => Promise<void>,
): Promise<DeleteMessageResult> {
  const deleteId = newUlid();

  const event: Event = {
    id: deleteId,
    room: options.roomId,
    $type: "space.roomy.message.deleteMessage.v0",
    messageId: options.messageId,
  };

  await sendEvent(event);

  return { id: deleteId };
}

/**
 * Options for deleting multiple messages.
 */
export interface DeleteMessagesOptions {
  /** The room containing the messages */
  roomId: Ulid;
  /** The IDs of the messages to delete */
  messageIds: Ulid[];
}

/**
 * Result of deleting multiple messages.
 */
export interface DeleteMessagesResult {
  /** The IDs of the delete events, one per deleted message. */
  ids: Ulid[];
}

/**
 * Delete several messages from one room.
 *
 * `DeleteMessageSchema` is single-`messageId`, so this emits one event per
 * message — the same shape {@link moveMessages} takes for the same reason.
 * The batching that keeps it to a single round-trip happens in the caller
 * (app-lite's `deleteMessages` mutation sends them as one `sendEvents` call).
 *
 * @param options - Message delete options
 * @param sendEvent - Function to send each event
 * @returns The IDs of the emitted delete events
 *
 * @example
 * ```ts
 * const result = await deleteMessages({
 *   roomId: "01H...",
 *   messageIds: ["01J...", "01K..."],
 * }, sendEvent);
 * ```
 */
export async function deleteMessages(
  options: DeleteMessagesOptions,
  sendEvent: (event: Event) => Promise<void>,
): Promise<DeleteMessagesResult> {
  const ids: Ulid[] = [];

  for (const messageId of options.messageIds) {
    const id = newUlid();
    ids.push(id);

    const event: Event = {
      id,
      room: options.roomId,
      $type: "space.roomy.message.deleteMessage.v0",
      messageId,
    };

    await sendEvent(event);
  }

  return { ids };
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
 * @param options - Message reorder options
 * @param sendEvent - Function to send the event
 * @returns The ID of the reorder event
 *
 * @example
 * ```ts
 * const result = await reorderMessage({
 *   roomId: "01H...",
 *   messageId: "01J...",
 *   after: "01K..."
 * }, sendEvent);
 * ```
 */
export async function reorderMessage(
  options: ReorderMessageOptions,
  sendEvent: (event: Event) => Promise<void>,
): Promise<ReorderMessageResult> {
  const reorderId = newUlid();

  const event: Event = {
    id: reorderId,
    room: options.roomId,
    $type: "space.roomy.message.reorderMessage.v0",
    messageId: options.messageId,
    after: options.after,
  };

  await sendEvent(event);

  return { id: reorderId };
}
/**
 * Options for moving messages to another room.
 */
export interface MoveMessagesOptions {
  /** The room the messages currently live in (the event's `room`). */
  fromRoomId: Ulid;
  /** The message IDs to move. */
  messageIds: Ulid[];
  /** The room the messages should be moved to. */
  toRoomId: Ulid;
}

/**
 * Result of moving messages.
 */
export interface MoveMessagesResult {
  /** The IDs of the move events, one per moved message. */
  ids: Ulid[];
}

/**
 * Move messages from one room to another — the originals change room; nothing
 * is copied. Unlike {@link forwardMessage} (which creates a new message
 * embedding the original), a move relocates the existing message entity.
 *
 * The event schema caps `messageIds` at one entry (`MoveMessagesSchema` in
 * `schema/events/message.ts`: "Must be exactly one until we have TVFs in
 * LibSQL"), so this emits one event per message.
 *
 * @param options - Message move options
 * @param sendEvent - Function to send the event
 * @returns The IDs of the emitted move events
 *
 * @example
 * ```ts
 * const result = await moveMessages({
 *   fromRoomId: "01H...", // source channel
 *   toRoomId: "01J...",   // destination room
 *   messageIds: ["01K...", "01L..."],
 * }, sendEvent);
 * ```
 */
export async function moveMessages(
  options: MoveMessagesOptions,
  sendEvent: (event: Event) => Promise<void>,
): Promise<MoveMessagesResult> {
  const ids: Ulid[] = [];

  for (const messageId of options.messageIds) {
    const id = newUlid();
    ids.push(id);

    const event: Event = {
      id,
      room: options.fromRoomId,
      $type: "space.roomy.message.moveMessages.v0",
      messageIds: [messageId],
      toRoomId: options.toRoomId,
    };

    await sendEvent(event);
  }

  return { ids };
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
 * @deprecated Prefer {@link forwardMessage}, which represents a forward as a
 * `createMessage` event carrying a `space.roomy.attachment.forward.v0`
 * attachment (a real message that embeds the original). This legacy event is
 * kept for backwards compatibility with older producers and already-
 * materialised forward-reference entities.
 *
 * @param options - Message forward options
 * @param sendEvent - Function to send the event
 * @returns The ID of the forward event
 *
 * @example
 * ```ts
 * const result = await forwardMessages({
 *   roomId: "01H...",  // thread room
 *   fromRoomId: "01J...", // parent channel
 *   messageIds: ["01K...", "01L..."]
 * }, sendEvent);
 * ```
 */
export async function forwardMessages(
  options: ForwardMessagesOptions,
  sendEvent: (event: Event) => Promise<void>,
): Promise<ForwardMessagesResult> {
  const forwardId = newUlid();

  const event: Event = {
    id: forwardId,
    room: options.roomId,
    $type: "space.roomy.message.forwardMessages.v0",
    messageIds: options.messageIds,
    fromRoomId: options.fromRoomId,
  };

  await sendEvent(event);

  return { id: forwardId };
}

/**
 * Options for forwarding a single message as an embed.
 */
export interface ForwardMessageOptions {
  /** The destination room ID */
  roomId: Ulid;
  /** The room the original message currently lives in. */
  fromRoomId: Ulid;
  /** The ID of the original message to forward. */
  messageId: Ulid;
  /** Optional body the forwarder wants to add alongside the embed. */
  body?: string;
  /** The MIME type of the body (default: text/markdown). */
  mimeType?: string;
}

/**
 * Result of forwarding a message.
 */
export interface ForwardMessageResult {
  /** The ID of the created forward message. */
  id: Ulid;
}

/**
 * Forward a message to another room as an embed. Sends a `createMessage`
 * event carrying a `space.roomy.attachment.forward.v0` attachment, so the
 * destination gets a real message (with the forwarder's optional body) that
 * embeds the original. This is the modern replacement for the deprecated
 * `forwardMessages` event.
 *
 * @param options - Message forward options
 * @param sendEvent - Function to send the event
 * @returns The ID of the created forward message
 *
 * @example
 * ```ts
 * const result = await forwardMessage({
 *   roomId: "01H...",
 *   fromRoomId: "01J...",
 *   messageId: "01K...",
 *   body: "Worth a read",
 * }, sendEvent);
 * ```
 */
export async function forwardMessage(
  options: ForwardMessageOptions,
  sendEvent: (event: Event) => Promise<void>,
): Promise<ForwardMessageResult> {
  const messageId = newUlid();

  const extensions: Record<string, unknown> = {
    "space.roomy.extension.attachments.v0": {
      $type: "space.roomy.extension.attachments.v0",
      attachments: [
        {
          $type: "space.roomy.attachment.forward.v0",
          target: options.messageId,
          fromRoomId: options.fromRoomId,
        },
      ],
    },
  };

  const event: Event = {
    id: messageId,
    room: options.roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: {
      mimeType: options.mimeType || "text/markdown",
      data: toBytes(new TextEncoder().encode(options.body ?? "")),
    },
    extensions,
  };

  await sendEvent(event);

  return { id: messageId };
}
