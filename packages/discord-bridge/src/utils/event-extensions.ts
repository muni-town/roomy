/**
 * Extension extraction utilities for Roomy events.
 *
 * Discord origin extensions are added to events that originated from Discord,
 * allowing us to track the source and prevent sync loops.
 */

import type { DecodedStreamEvent } from "@roomy/sdk";

/**
 * Extension type key constants.
 */
export const DISCORD_EXTENSION_KEYS = {
  MESSAGE_ORIGIN: "space.roomy.extension.discordMessageOrigin.v0" as const,
  ROOM_ORIGIN: "space.roomy.extension.discordOrigin.v0" as const,
  USER_ORIGIN: "space.roomy.extension.discordUserOrigin.v0" as const,
  SIDEBAR_ORIGIN: "space.roomy.extension.discordSidebarOrigin.v0" as const,
  ROOM_LINK_ORIGIN: "space.roomy.extension.discordRoomLinkOrigin.v0" as const,
  REACTION_ORIGIN: "space.roomy.extension.discordReactionOrigin.v0" as const,
} as const;

/**
 * Discord message origin extension data.
 * Present on createMessage events that originated from Discord.
 */
export interface DiscordMessageOrigin {
  snowflake: string;
  channelId: string;
  guildId: string;
  editedTimestamp?: number;
  contentHash?: string;
}

/**
 * Discord room origin extension data.
 * Present on createRoom events that originated from Discord.
 */
export interface DiscordOrigin {
  snowflake: string;
  guildId: string;
}

/**
 * Discord user origin extension data.
 * Present on updateProfile events for Discord users.
 */
export interface DiscordUserOrigin {
  snowflake: string;
  guildId: string;
  profileHash: string;
  handle: string;
}

/**
 * Discord sidebar origin extension data.
 * Present on updateSidebar events that originated from Discord.
 */
export interface DiscordSidebarOrigin {
  guildId: string;
  sidebarHash: string;
}

/**
 * Discord room link origin extension data.
 * Present on createRoomLink events that originated from Discord.
 */
export interface DiscordRoomLinkOrigin {
  parentSnowflake: string;
  childSnowflake: string;
  guildId: string;
}

/**
 * Discord reaction origin extension data.
 * Present on bridged reaction events (addBridgedReaction/removeBridgedReaction).
 */
export interface DiscordReactionOrigin {
  snowflake: string;
  messageId: string;
  channelId: string;
  userId: string;
  emoji: string;
  guildId: string;
}

/**
 * Generic helper to extract an extension from an event.
 * @param event - The event to extract from
 * @param extensionKey - The extension key to look for
 * @param eventType - Optional event type to filter by
 * @returns The extension value or undefined
 */
function extractExtension<T>(
  event: DecodedStreamEvent["event"],
  extensionKey: string,
  eventType?: string,
): T | undefined {
  if (eventType && event.$type !== eventType) return undefined;

  const extensions = (event as { extensions?: Record<string, unknown> })
    .extensions;
  if (!extensions) return undefined;

  return extensions[extensionKey] as T | undefined;
}

/**
 * Extract Discord message origin extension from an event if present.
 */
export function extractDiscordMessageOrigin(
  event: DecodedStreamEvent["event"],
): DiscordMessageOrigin | undefined {
  return extractExtension<DiscordMessageOrigin>(
    event,
    DISCORD_EXTENSION_KEYS.MESSAGE_ORIGIN,
  );
}

/**
 * Extract Discord room origin extension from an event if present.
 */
export function extractDiscordOrigin(
  event: DecodedStreamEvent["event"],
): DiscordOrigin | undefined {
  return extractExtension<DiscordOrigin>(
    event,
    DISCORD_EXTENSION_KEYS.ROOM_ORIGIN,
  );
}

/**
 * Extract Discord user origin extension from an event if present.
 */
export function extractDiscordUserOrigin(
  event: DecodedStreamEvent["event"],
): DiscordUserOrigin | undefined {
  return extractExtension<DiscordUserOrigin>(
    event,
    DISCORD_EXTENSION_KEYS.USER_ORIGIN,
    "space.roomy.user.updateProfile.v0",
  );
}

/**
 * Extract Discord sidebar origin extension from an event if present.
 */
export function extractDiscordSidebarOrigin(
  event: DecodedStreamEvent["event"],
): DiscordSidebarOrigin | undefined {
  return extractExtension<DiscordSidebarOrigin>(
    event,
    DISCORD_EXTENSION_KEYS.SIDEBAR_ORIGIN,
    "space.roomy.space.updateSidebar.v0",
  );
}

/**
 * Extract Discord room link origin extension from an event if present.
 */
export function extractDiscordRoomLinkOrigin(
  event: DecodedStreamEvent["event"],
): { origin: DiscordRoomLinkOrigin; linkToRoom: string } | undefined {
  if (event.$type !== "space.roomy.link.createRoomLink.v0") return undefined;

  const origin = extractExtension<DiscordRoomLinkOrigin>(
    event,
    DISCORD_EXTENSION_KEYS.ROOM_LINK_ORIGIN,
  );
  if (!origin) return undefined;

  const linkToRoom = (event as { linkToRoom?: string }).linkToRoom;
  const room = (event as { room?: string }).room;
  if (!linkToRoom || !room) return undefined;

  return { origin, linkToRoom };
}

/**
 * Extract Discord reaction origin extension from an event if present.
 * Supports both addBridgedReaction and removeBridgedReaction events.
 */
export function extractDiscordReactionOrigin(
  event: DecodedStreamEvent["event"],
): DiscordReactionOrigin | undefined {
  // Check for addBridgedReaction event type
  if (event.$type === "space.roomy.reaction.addBridgedReaction.v0") {
    return extractExtension<DiscordReactionOrigin>(
      event,
      DISCORD_EXTENSION_KEYS.REACTION_ORIGIN,
      "space.roomy.reaction.addBridgedReaction.v0",
    );
  }
  // Check for removeBridgedReaction event type
  if (event.$type === "space.roomy.reaction.removeBridgedReaction.v0") {
    return extractExtension<DiscordReactionOrigin>(
      event,
      DISCORD_EXTENSION_KEYS.REACTION_ORIGIN,
      "space.roomy.reaction.removeBridgedReaction.v0",
    );
  }
  return undefined;
}
