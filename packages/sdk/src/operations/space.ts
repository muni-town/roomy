/**
 * Space operations for Roomy.
 * High-level functions for creating and managing spaces.
 */

import { newUlid, type Ulid } from "../schema";
import type { Event, StreamDid } from "../schema";

/**
 * Options for creating a default space.
 */
export interface CreateDefaultSpaceOptions {
  /** The space name */
  name: string;
  /** The space description (optional) */
  description?: string;
  /** Avatar URL (optional) */
  avatar?: string;
}

/**
 * Sidebar category configuration.
 */
export interface SidebarCategory {
  /** Category name */
  name: string;
  /** Child room IDs */
  children: Ulid[];
}

/**
 * Result of creating a default space.
 */
export interface CreateDefaultSpaceResult {
  /** The ID of the space info update event */
  infoEventId: Ulid;
  /** The ID of the lobby channel room */
  lobbyRoomId: Ulid;
  /** The ID of the sidebar update event */
  sidebarEventId: Ulid;
}

/**
 * Generate the events required to create a default space with a lobby channel.
 *
 * This returns an array of events that can be sent via `sendEventBatch`.
 * The default space structure includes:
 * - Space info (name, description, avatar)
 * - A "lobby" channel
 * - A sidebar with a "general" category containing the lobby channel
 *
 * @param options - Space creation options
 * @returns Array of events to send
 *
 * @example
 * ```ts
 * const events = createDefaultSpaceEvents({
 *   name: "My Space",
 *   description: "A great space"
 * });
 * await space.sendEventBatch(events);
 * ```
 */
export function createDefaultSpaceEvents(
  options: CreateDefaultSpaceOptions,
): Event[] {
  const infoEventId = newUlid();
  const lobbyRoomId = newUlid();
  const sidebarEventId = newUlid();

  const events: Event[] = [
    // Update space info
    {
      id: infoEventId,
      $type: "space.roomy.space.updateSpaceInfo.v0",
      name: options.name,
      ...(options.description !== undefined && { description: options.description }),
      ...(options.avatar !== undefined && { avatar: options.avatar }),
    },
    // Create lobby channel
    {
      id: lobbyRoomId,
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name: "lobby",
    },
    // Create sidebar with general category containing lobby
    {
      id: sidebarEventId,
      $type: "space.roomy.space.updateSidebar.v0",
      categories: [
        {
          name: "general",
          children: [lobbyRoomId],
        },
      ],
    },
  ];

  return events;
}

/**
 * Create a default space with a lobby channel.
 *
 * Sends the default space events to create a space with:
 * - Space info (name, description, avatar)
 * - A "lobby" channel
 * - A sidebar with a "general" category containing the lobby channel
 *
 * Note: This function only sends events to an already-created space stream.
 * To create the stream itself, use `ConnectedSpace.create()` or `RoomyClient.connectPersonalSpace()`.
 *
 * @param space - The connected space to send events to (must already exist)
 * @param options - Space creation options
 * @returns The IDs of created entities
 *
 * @example
 * ```ts
 * // First create the space stream
 * const space = await ConnectedSpace.create({
 *   client: roomyClient,
 *   module: modules.space,
 * }, userDid);
 *
 * // Then initialize it with default structure
 * const result = await createDefaultSpace(space, {
 *   name: "My Space",
 *   description: "A great space"
 * });
 * console.log("Created lobby channel:", result.lobbyRoomId);
 * ```
 */
export async function createDefaultSpace(
  space: { sendEvent(event: Event): Promise<void>; sendEventBatch(events: Event[]): Promise<void> },
  options: CreateDefaultSpaceOptions,
): Promise<CreateDefaultSpaceResult> {
  const events = createDefaultSpaceEvents(options);

  await space.sendEventBatch(events);

  // Extract IDs from events (events array is guaranteed to have 3 elements)
  const infoEvent = events[0]!;
  const lobbyEvent = events[1]!;
  const sidebarEvent = events[2]!;
  const infoEventId = infoEvent.id as Ulid;
  const lobbyRoomId = lobbyEvent.id as Ulid;
  const sidebarEventId = sidebarEvent.id as Ulid;

  return {
    infoEventId,
    lobbyRoomId,
    sidebarEventId,
  };
}

/**
 * Generate events to update the space info.
 *
 * @param options - Space info update options
 * @returns Event to send
 */
export function updateSpaceInfoEvents(
  options: Omit<CreateDefaultSpaceOptions, "name"> & { name?: string },
): Event {
  const infoEventId = newUlid();

  return {
    id: infoEventId,
    $type: "space.roomy.space.updateSpaceInfo.v0",
    ...(options.name !== undefined && { name: options.name }),
    ...(options.description !== undefined && { description: options.description }),
    ...(options.avatar !== undefined && { avatar: options.avatar }),
  };
}

/**
 * Generate events to update the sidebar.
 *
 * @param categories - Sidebar categories
 * @returns Event to send
 */
export function updateSidebarEvents(categories: SidebarCategory[]): Event {
  const sidebarEventId = newUlid();

  return {
    id: sidebarEventId,
    $type: "space.roomy.space.updateSidebar.v0",
    categories,
  };
}
