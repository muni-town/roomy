/**
 * Room operations for Roomy.
 * High-level functions for creating and managing rooms, threads, and pages.
 */

import { newUlid, toBytes, type Ulid } from "../schema";
import type { RoomKind } from "../schema/events/room";
import type { Event, BasicInfoUpdate } from "../schema";
import type { ConnectedSpace } from "../connection";

/**
 * Basic information for a room.
 */
export interface RoomInfo {
  /** The room name */
  name?: string;
  /** The room description */
  description?: string;
  /** Avatar URL */
  avatar?: string;
}

/**
 * Options for creating a room.
 */
export interface CreateRoomOptions extends RoomInfo {
  /** The kind of room to create */
  kind: RoomKind;
}

/**
 * Result of creating a room.
 */
export interface CreateRoomResult {
  /** The ID of the created room */
  id: Ulid;
}

/**
 * Create a room.
 *
 * @param space - The connected space to send the event to
 * @param options - Room creation options
 * @returns The ID of the created room
 *
 * @example
 * ```ts
 * const result = await createRoom(space, {
 *   kind: "space.roomy.channel",
 *   name: "general",
 *   description: "General discussion"
 * });
 * console.log("Created room:", result.id);
 * ```
 */
export async function createRoom(
  space: ConnectedSpace,
  options: CreateRoomOptions,
): Promise<CreateRoomResult> {
  const roomId = newUlid();

  const event: Event = {
    id: roomId,
    $type: "space.roomy.room.createRoom.v0",
    kind: options.kind,
    ...(options.name && { name: options.name }),
    ...(options.description && { description: options.description }),
    ...(options.avatar && { avatar: options.avatar }),
  };

  await space.sendEvent(event);

  return { id: roomId };
}

/**
 * Options for updating a room.
 */
export interface UpdateRoomOptions {
  /** The room ID to update */
  roomId: Ulid;
  /** The new room kind */
  kind?: RoomKind | null;
  /** The new room name */
  name?: string;
  /** The new room description */
  description?: string;
  /** The new avatar URL */
  avatar?: string;
}

/**
 * Result of updating a room.
 */
export interface UpdateRoomResult {
  /** The ID of the update event */
  id: Ulid;
}

/**
 * Update a room.
 *
 * @param space - The connected space to send the event to
 * @param options - Room update options
 * @returns The ID of the update event
 *
 * @example
 * ```ts
 * const result = await updateRoom(space, {
 *   roomId: "01H...",
 *   name: "new-name",
 *   kind: "space.roomy.thread"
 * });
 * ```
 */
export async function updateRoom(
  space: ConnectedSpace,
  options: UpdateRoomOptions,
): Promise<UpdateRoomResult> {
  const updateId = newUlid();

  const updateBody: BasicInfoUpdate & {
    roomId: Ulid;
    kind?: RoomKind | null;
  } = {
    roomId: options.roomId,
    ...(options.kind !== undefined && { kind: options.kind }),
    ...(options.name !== undefined && { name: options.name }),
    ...(options.description !== undefined && { description: options.description }),
    ...(options.avatar !== undefined && { avatar: options.avatar }),
  };

  const event: Event = {
    id: updateId,
    $type: "space.roomy.room.updateRoom.v0",
    ...updateBody,
  };

  await space.sendEvent(event);

  return { id: updateId };
}

/**
 * Options for deleting a room.
 */
export interface DeleteRoomOptions {
  /** The room ID to delete */
  roomId: Ulid;
}

/**
 * Result of deleting a room.
 */
export interface DeleteRoomResult {
  /** The ID of the delete event */
  id: Ulid;
}

/**
 * Delete a room.
 *
 * @param space - The connected space to send the event to
 * @param options - Room delete options
 * @returns The ID of the delete event
 *
 * @example
 * ```ts
 * const result = await deleteRoom(space, {
 *   roomId: "01H..."
 * });
 * ```
 */
export async function deleteRoom(
  space: ConnectedSpace,
  options: DeleteRoomOptions,
): Promise<DeleteRoomResult> {
  const deleteId = newUlid();

  const event: Event = {
    id: deleteId,
    $type: "space.roomy.room.deleteRoom.v0",
    roomId: options.roomId,
  };

  await space.sendEvent(event);

  return { id: deleteId };
}

/**
 * Options for creating a thread.
 */
export interface CreateThreadOptions extends RoomInfo {
  /** The parent room to link the thread to */
  linkToRoom: Ulid;
}

/**
 * Result of creating a thread.
 */
export interface CreateThreadResult {
  /** The ID of the created thread */
  id: Ulid;
}

/**
 * Create a thread room linked to a parent room.
 *
 * @param space - The connected space to send the event to
 * @param options - Thread creation options
 * @returns The ID of the created thread
 *
 * @example
 * ```ts
 * const result = await createThread(space, {
 *   linkToRoom: "01H...",
 *   name: "Thread name"
 * });
 * ```
 */
export async function createThread(
  space: ConnectedSpace,
  options: CreateThreadOptions,
): Promise<CreateThreadResult> {
  // First create the thread room
  const { id: threadId } = await createRoom(space, {
    kind: "space.roomy.thread",
    ...options,
  });

  // Then link it to the parent room
  const linkId = newUlid();
  const linkEvent: Event = {
    id: linkId,
    room: options.linkToRoom,
    $type: "space.roomy.link.createRoomLink.v0",
    linkToRoom: threadId,
  };

  await space.sendEvent(linkEvent);

  return { id: threadId };
}

/**
 * Options for creating a page.
 */
export interface CreatePageOptions extends RoomInfo {
  /** The parent room ID */
  parentRoomId: Ulid;
  /** Initial page content (optional) */
  content?: string;
}

/**
 * Result of creating a page.
 */
export interface CreatePageResult {
  /** The ID of the created page */
  id: Ulid;
}

/**
 * Create a page room with optional initial content.
 *
 * @param space - The connected space to send the event to
 * @param options - Page creation options
 * @returns The ID of the created page
 *
 * @example
 * ```ts
 * const result = await createPage(space, {
 *   parentRoomId: "01H...",
 *   name: "My Page",
 *   content: "# Page content\n\n..."
 * });
 * ```
 */
export async function createPage(
  space: ConnectedSpace,
  options: CreatePageOptions,
): Promise<CreatePageResult> {
  // First create the page room
  const { id: pageId } = await createRoom(space, {
    kind: "space.roomy.page",
    ...options,
  });

  // If content is provided, create an initial edit event
  if (options.content !== undefined) {
    const editId = newUlid();
    const editEvent: Event = {
      id: editId,
      room: pageId,
      $type: "space.roomy.page.editPage.v0",
      body: {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(options.content)),
      },
    };

    await space.sendEvent(editEvent);
  }

  return { id: pageId };
}

/**
 * Options for editing a page.
 */
export interface EditPageOptions {
  /** The page room ID */
  roomId: Ulid;
  /** The page content */
  body: string;
  /** The MIME type of the body (default: text/markdown) */
  mimeType?: string;
  /** ID of edit event directly preceding this one */
  previous?: Ulid;
}

/**
 * Result of editing a page.
 */
export interface EditPageResult {
  /** The ID of the edit event */
  id: Ulid;
}

/**
 * Edit a page.
 *
 * @param space - The connected space to send the event to
 * @param options - Page edit options
 * @returns The ID of the edit event
 *
 * @example
 * ```ts
 * const result = await editPage(space, {
 *   roomId: "01H...",
 *   body: "# Updated content\n\n..."
 * });
 * ```
 */
export async function editPage(
  space: ConnectedSpace,
  options: EditPageOptions,
): Promise<EditPageResult> {
  const editId = newUlid();

  const event: Event = {
    id: editId,
    room: options.roomId,
    $type: "space.roomy.page.editPage.v0",
    body: {
      mimeType: options.mimeType || "text/markdown",
      data: toBytes(new TextEncoder().encode(options.body)),
    },
    ...(options.previous && { previous: options.previous }),
  };

  await space.sendEvent(event);

  return { id: editId };
}

/**
 * Options for creating a room link.
 */
export interface CreateRoomLinkOptions {
  /** The room to create the link in */
  roomId: Ulid;
  /** The room to link to */
  linkToRoom: Ulid;
}

/**
 * Result of creating a room link.
 */
export interface CreateRoomLinkResult {
  /** The ID of the link event */
  id: Ulid;
}

/**
 * Create a link from one room to another.
 *
 * @param space - The connected space to send the event to
 * @param options - Room link options
 * @returns The ID of the link event
 *
 * @example
 * ```ts
 * const result = await createRoomLink(space, {
 *   roomId: "01H...",
 *   linkToRoom: "01J..."
 * });
 * ```
 */
export async function createRoomLink(
  space: ConnectedSpace,
  options: CreateRoomLinkOptions,
): Promise<CreateRoomLinkResult> {
  const linkId = newUlid();

  const event: Event = {
    id: linkId,
    room: options.roomId,
    $type: "space.roomy.link.createRoomLink.v0",
    linkToRoom: options.linkToRoom,
  };

  await space.sendEvent(event);

  return { id: linkId };
}

/**
 * Options for removing a room link.
 */
export interface RemoveRoomLinkOptions {
  /** The room containing the link */
  roomId: Ulid;
  /** The link event ID to remove */
  linkId: Ulid;
}

/**
 * Result of removing a room link.
 */
export interface RemoveRoomLinkResult {
  /** The ID of the remove link event */
  id: Ulid;
}

/**
 * Remove a room link.
 *
 * @param space - The connected space to send the event to
 * @param options - Room link remove options
 * @returns The ID of the remove link event
 *
 * @example
 * ```ts
 * const result = await removeRoomLink(space, {
 *   roomId: "01H...",
 *   linkId: "01J..."
 * });
 * ```
 */
export async function removeRoomLink(
  space: ConnectedSpace,
  options: RemoveRoomLinkOptions,
): Promise<RemoveRoomLinkResult> {
  const removeId = newUlid();

  const event: Event = {
    id: removeId,
    room: options.roomId,
    $type: "space.roomy.link.removeRoomLink.v0",
    linkId: options.linkId,
  };

  await space.sendEvent(event);

  return { id: removeId };
}
