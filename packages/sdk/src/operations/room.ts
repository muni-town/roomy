/**
 * Room operations for Roomy.
 * High-level functions for creating and managing rooms, threads, and pages.
 */

import { newUlid, toBytes, type Ulid } from "../schema";
import type { RoomKind } from "../schema/events/room";
import type { Event } from "../schema";

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
  /** Additional extensions to include with the event */
  extensions?: Record<string, unknown>;
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
 * @param options - Room creation options
 * @returns Array containing the createRoom event
 *
 * @example
 * ```ts
 * const events = createRoom({
 *   kind: "space.roomy.channel",
 *   name: "general",
 *   description: "General discussion"
 * });
 * // events[0].id is the room ID
 * ```
 */
export function createRoom(options: CreateRoomOptions): Event[] {
  const roomId = newUlid();

  const event: Event = {
    id: roomId,
    $type: "space.roomy.room.createRoom.v0",
    kind: options.kind,
    ...(options.name && { name: options.name }),
    ...(options.description && { description: options.description }),
    ...(options.avatar && { avatar: options.avatar }),
    ...(options.extensions && { extensions: options.extensions }),
  };

  return [event];
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
 * @param options - Room update options
 * @returns Array containing the updateRoom event
 *
 * @example
 * ```ts
 * const events = updateRoom({
 *   roomId: "01H...",
 *   name: "new-name",
 *   kind: "space.roomy.thread"
 * });
 * ```
 */
export function updateRoom(options: UpdateRoomOptions): Event[] {
  const updateId = newUlid();

  const event: Event = {
    id: updateId,
    $type: "space.roomy.room.updateRoom.v0",
    roomId: options.roomId,
    ...(options.kind !== undefined && { kind: options.kind }),
    ...(options.name !== undefined && { name: options.name }),
    ...(options.description !== undefined && {
      description: options.description,
    }),
    ...(options.avatar !== undefined && { avatar: options.avatar }),
  };

  return [event];
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
 * @param options - Room delete options
 * @returns Array containing the deleteRoom event
 *
 * @example
 * ```ts
 * const events = deleteRoom({
 *   roomId: "01H..."
 * });
 * ```
 */
export function deleteRoom(options: DeleteRoomOptions): Event[] {
  const deleteId = newUlid();

  const event: Event = {
    id: deleteId,
    $type: "space.roomy.room.deleteRoom.v0",
    roomId: options.roomId,
  };

  return [event];
}

/**
 * Options for creating a thread.
 */
export interface CreateThreadOptions extends RoomInfo {
  /** The parent room to link the thread to */
  linkToRoom: Ulid;
  /** Additional extensions to include with the room event */
  extensions?: Record<string, unknown>;
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
 * @param options - Thread creation options
 * @returns Array containing the createRoom and createRoomLink events
 *
 * @example
 * ```ts
 * const events = createThread({
 *   linkToRoom: "01H...",
 *   name: "Thread name"
 * });
 * // events[0].id is the thread room ID
 * ```
 */
export function createThread(options: CreateThreadOptions): Event[] {
  // First create the thread room
  const roomEvents = createRoom({
    kind: "space.roomy.thread",
    name: options.name,
    description: options.description,
    avatar: options.avatar,
    extensions: options.extensions,
  });

  const threadId = roomEvents[0]!.id;

  // Then link it to the parent room
  const linkId = newUlid();
  const linkEvent: Event = {
    id: linkId,
    room: options.linkToRoom,
    $type: "space.roomy.link.createRoomLink.v0",
    linkToRoom: threadId,
  };

  return [...roomEvents, linkEvent];
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
 * @param options - Page creation options
 * @returns Array containing the createRoom event and optionally an editPage event
 *
 * @example
 * ```ts
 * const events = createPage({
 *   parentRoomId: "01H...",
 *   name: "My Page",
 *   content: "# Page content\n\n..."
 * });
 * // events[0].id is the page room ID
 * ```
 */
export function createPage(options: CreatePageOptions): Event[] {
  // First create the page room
  const roomEvents = createRoom({
    kind: "space.roomy.page",
    ...options,
  });

  const pageId = roomEvents[0]!.id;
  const events = [...roomEvents];

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

    events.push(editEvent);
  }

  return events;
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
 * @param options - Page edit options
 * @returns Array containing the editPage event
 *
 * @example
 * ```ts
 * const events = editPage({
 *   roomId: "01H...",
 *   body: "# Updated content\n\n..."
 * });
 * ```
 */
export function editPage(options: EditPageOptions): Event[] {
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

  return [event];
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
 * @param options - Room link options
 * @returns Array containing the createRoomLink event
 *
 * @example
 * ```ts
 * const events = createRoomLink({
 *   roomId: "01H...",
 *   linkToRoom: "01J..."
 * });
 * ```
 */
export function createRoomLink(options: CreateRoomLinkOptions): Event[] {
  const linkId = newUlid();

  const event: Event = {
    id: linkId,
    room: options.roomId,
    $type: "space.roomy.link.createRoomLink.v0",
    linkToRoom: options.linkToRoom,
  };

  return [event];
}

/**
 * Options for removing a room link.
 */
export interface RemoveRoomLinkOptions {
  /** The room containing the link */
  roomId: Ulid;
  /** The linked room to unlink */
  linkToRoom: Ulid;
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
 * @param options - Room link remove options
 * @returns Array containing the removeRoomLink event
 *
 * @example
 * ```ts
 * const events = removeRoomLink({
 *   roomId: "01H...",
 *   linkToRoom: "01J..."
 * });
 * ```
 */
export function removeRoomLink(options: RemoveRoomLinkOptions): Event[] {
  const removeId = newUlid();

  const event: Event = {
    id: removeId,
    room: options.roomId,
    $type: "space.roomy.link.removeRoomLink.v0",
    linkToRoom: options.linkToRoom,
  };

  return [event];
}
