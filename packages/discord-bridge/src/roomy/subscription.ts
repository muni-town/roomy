/**
 * Leaf subscription handler for processing Roomy events.
 *
 * Updates LevelDB state (syncedIds, cursors) based on incoming events.
 * This is the single place where derived state is updated from the
 * source of truth (Leaf event stream).
 */

import type { DecodedStreamEvent, EventCallbackMeta } from "@roomy/sdk";
import {
  leafCursors,
  syncedIdsForBridge,
  syncedProfilesForBridge,
  syncedSidebarHashForBridge,
  syncedRoomLinksForBridge,
  syncedEditsForBridge,
  registeredBridges,
  roomyUserProfilesForBridge,
} from "../repositories/db.js";
import { botState } from "../discord/bot.js";
import { getGuildContext } from "../discord/bot.js";

/**
 * Extension type key constants.
 * Exported for use in to.ts to avoid duplication and typos.
 */
export const DISCORD_EXTENSION_KEYS = {
  MESSAGE_ORIGIN: "space.roomy.extension.discordMessageOrigin.v0" as const,
  ROOM_ORIGIN: "space.roomy.extension.discordOrigin.v0" as const,
  USER_ORIGIN: "space.roomy.extension.discordUserOrigin.v0" as const,
  SIDEBAR_ORIGIN: "space.roomy.extension.discordSidebarOrigin.v0" as const,
  ROOM_LINK_ORIGIN: "space.roomy.extension.discordRoomLinkOrigin.v0" as const,
  REACTION_ORIGIN: "space.roomy.extension.discordReactionOrigin.v0" as const,
} as const;

interface DiscordMessageOrigin {
  snowflake: string;
  channelId: string;
  guildId: string;
  editedTimestamp?: number;
  contentHash?: string;
}

interface DiscordOrigin {
  snowflake: string;
  guildId: string;
}

interface DiscordUserOrigin {
  snowflake: string;
  guildId: string;
  profileHash: string;
  handle: string;
}

interface DiscordSidebarOrigin {
  guildId: string;
  sidebarHash: string;
}

interface DiscordRoomLinkOrigin {
  parentSnowflake: string;
  childSnowflake: string;
  guildId: string;
}

interface DiscordReactionOrigin {
  snowflake: string;
  messageId: string;
  channelId: string;
  userId: string;
  emoji: string;
  guildId: string;
}

/**
 * Create a subscription handler for a connected space.
 * Updates LevelDB state based on incoming events.
 *
 * @param spaceId - The space DID being subscribed to
 * @returns Event callback function for ConnectedSpace.subscribe()
 */
export function createSpaceSubscriptionHandler(spaceId: string) {
  return async (
    events: DecodedStreamEvent[],
    meta: EventCallbackMeta,
  ): Promise<void> => {
    // Find the guild ID for this space
    const guildIdStr = await registeredBridges.get_spaceId(spaceId);
    if (!guildIdStr) {
      console.warn(`No guild registered for space ${spaceId}, skipping events`);
      return;
    }

    const guildId = BigInt(guildIdStr);
    const syncedIds = syncedIdsForBridge({
      discordGuildId: guildId,
      roomySpaceId: spaceId,
    });

    let maxIdx = 0;

    for (const decodedEvent of events) {
      const { idx, event, user } = decodedEvent;
      maxIdx = Math.max(maxIdx, idx);

      // Check for Discord message origin extension
      const messageOrigin = extractDiscordMessageOrigin(event);
      if (messageOrigin) {
        try {
          await syncedIds.register({
            discordId: messageOrigin.snowflake,
            roomyId: event.id,
          });
        } catch (e) {
          // Already registered - this is fine, idempotent
          if (!(e instanceof Error && e.message.includes("already registered"))) {
            console.error("Error registering synced ID:", e);
          }
        }
      }

      // Check for Discord room origin extension
      const roomOrigin = extractDiscordOrigin(event);
      if (roomOrigin) {
        try {
          await syncedIds.register({
            discordId: `room:${roomOrigin.snowflake}`,
            roomyId: event.id,
          });
        } catch (e) {
          // Already registered - this is fine, idempotent
          if (!(e instanceof Error && e.message.includes("already registered"))) {
            console.error("Error registering synced ID:", e);
          }
        }
      }

      // Check for Discord user origin extension (profile sync)
      const userOrigin = extractDiscordUserOrigin(event);
      if (userOrigin && userOrigin.guildId === guildIdStr) {
        const syncedProfiles = syncedProfilesForBridge({
          discordGuildId: guildId,
          roomySpaceId: spaceId,
        });
        try {
          await syncedProfiles.put(userOrigin.snowflake, userOrigin.profileHash);
        } catch (e) {
          console.error("Error caching profile hash:", e);
        }
      }

      // Capture Roomy user profiles from updateProfile events (non-Discord users)
      if (event.$type === "space.roomy.user.updateProfile.v0" && !userOrigin) {
        const profileEvent = event as {
          did: string;
          name?: string;
          avatar?: string | null;
        };
        if (profileEvent.did) {
          const roomyProfiles = roomyUserProfilesForBridge({
            discordGuildId: guildId,
            roomySpaceId: spaceId,
          });
          try {
            await roomyProfiles.put(profileEvent.did, {
              name: profileEvent.name || "Unknown",
              avatar: profileEvent.avatar ?? null,
            });
            console.log(`[Profile Capture] Cached Roomy user profile: did=${profileEvent.did}, name=${profileEvent.name || "Unknown"}`);
          } catch (e) {
            console.error("Error caching Roomy user profile:", e);
          }
        }
      }

      // Check for Discord sidebar origin extension
      const sidebarOrigin = extractDiscordSidebarOrigin(event);
      if (sidebarOrigin && sidebarOrigin.guildId === guildIdStr) {
        const sidebarHashStore = syncedSidebarHashForBridge({
          discordGuildId: guildId,
          roomySpaceId: spaceId,
        });
        try {
          await sidebarHashStore.put("sidebar", sidebarOrigin.sidebarHash);
        } catch (e) {
          console.error("Error caching sidebar hash:", e);
        }
      }

      // Check for Discord room link origin extension
      const roomLinkData = extractDiscordRoomLinkOrigin(event);
      if (roomLinkData && roomLinkData.origin.guildId === guildIdStr) {
        const syncedRoomLinks = syncedRoomLinksForBridge({
          discordGuildId: guildId,
          roomySpaceId: spaceId,
        });
        // Get the parent Roomy ID from the room field
        const parentRoomyId = (event as { room?: string }).room;
        if (parentRoomyId) {
          const linkKey = `${parentRoomyId}:${roomLinkData.linkToRoom}`;
          try {
            await syncedRoomLinks.put(linkKey, event.id);
          } catch (e) {
            console.error("Error caching room link:", e);
          }
        }
      }

      // Check for Discord message edit with origin extension
      if (event.$type === "space.roomy.message.editMessage.v0") {
        const origin = extractDiscordMessageOrigin(event);
        if (origin?.editedTimestamp && origin?.contentHash) {
          const syncedEdits = syncedEditsForBridge({
            discordGuildId: guildId,
            roomySpaceId: spaceId,
          });
          try {
            await syncedEdits.put(origin.snowflake, {
              editedTimestamp: origin.editedTimestamp,
              contentHash: origin.contentHash,
            });
          } catch (e) {
            console.error("Error caching edit state:", e);
          }
        }
      }

      // Check for delete events and unregister mappings
      if (event.$type === "space.roomy.room.deleteRoom.v0") {
        try {
          const discordId = await syncedIds.get_roomyId(event.roomId);
          if (discordId) {
            await syncedIds.unregister({
              discordId,
              roomyId: event.roomId,
            });
          }
          // TODO: consider Roomy→Discord sync for deletions
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("isn't registered"))) {
            console.error("Error unregistering room:", e);
          }
        }
      }

      if (event.$type === "space.roomy.message.deleteMessage.v0") {
        try {
          const discordId = await syncedIds.get_roomyId(event.messageId);
          if (discordId) {
            await syncedIds.unregister({
              discordId,
              roomyId: event.messageId,
            });
          }
          // TODO: consider Roomy→Discord sync for deletions
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("isn't registered"))) {
            console.error("Error unregistering message:", e);
          }
        }
      }

      // Roomy → Discord real-time sync (only after backfill is complete)
      // Skip if this is during backfill or if the event has Discord origin
      if (!meta.isBackfill) {
        const messageOrigin = extractDiscordMessageOrigin(event);
        const roomOrigin = extractDiscordOrigin(event);
        const userOrigin = extractDiscordUserOrigin(event);
        const reactionOrigin = extractDiscordReactionOrigin(event);

        // Check if this is a reaction event (for bidirectional sync)
        // Includes both pure Roomy reactions (addReaction/removeReaction) and bridged reactions
        const isReactionEvent =
          event.$type === "space.roomy.reaction.addReaction.v0" ||
          event.$type === "space.roomy.reaction.removeReaction.v0" ||
          event.$type === "space.roomy.reaction.addBridgedReaction.v0" ||
          event.$type === "space.roomy.reaction.removeBridgedReaction.v0";

        // Get bot and guild context
        const bot = botState.bot;
        if (bot) {
          const ctx = await getGuildContext(guildId);

          if (ctx) {
            const orchestrator = ctx.orchestrator;

            // Sync non-Discord-origin events (messages, edits, deletes)
            if (!messageOrigin && !roomOrigin && !userOrigin && !reactionOrigin) {
              // Handle createMessage events
              if (event.$type === "space.roomy.message.createMessage.v0") {
                await orchestrator.handleRoomyCreateMessage(decodedEvent, bot).catch((error) => {
                  console.error(`Failed to sync Roomy message ${event.id} to Discord:`, error);
                });
              }

              // Handle editMessage events
              if (event.$type === "space.roomy.message.editMessage.v0") {
                await orchestrator.handleRoomyEditMessage(decodedEvent, bot).catch((error) => {
                  console.error(`Failed to sync Roomy edit ${event.id} to Discord:`, error);
                });
              }

              // Handle deleteMessage events
              if (event.$type === "space.roomy.message.deleteMessage.v0") {
                await orchestrator.handleRoomyDeleteMessage(decodedEvent, bot).catch((error) => {
                  console.error(`Failed to sync Roomy delete ${event.id} to Discord:`, error);
                });
              }
            }

            // Reactions sync bidirectionally (even on Discord-origin messages)
            // BUT block reactions that themselves have Discord origin (sync loop prevention)
            if (isReactionEvent && !reactionOrigin) {
              // Handle pure Roomy addReaction events
              if (event.$type === "space.roomy.reaction.addReaction.v0") {
                await orchestrator.handleRoomyAddReaction(decodedEvent, bot).catch((error) => {
                  console.error(`Failed to sync Roomy reaction ${event.id} to Discord:`, error);
                });
              }

              // Handle bridged addBridgedReaction events
              if (event.$type === "space.roomy.reaction.addBridgedReaction.v0") {
                await orchestrator.handleRoomyAddReaction(decodedEvent, bot).catch((error) => {
                  console.error(`Failed to sync Roomy reaction ${event.id} to Discord:`, error);
                });
              }

              // Handle pure Roomy removeReaction events
              if (event.$type === "space.roomy.reaction.removeReaction.v0") {
                await orchestrator.handleRoomyRemoveReaction(decodedEvent, bot).catch((error) => {
                  console.error(`Failed to sync Roomy reaction removal ${event.id} to Discord:`, error);
                });
              }

              // Handle bridged removeBridgedReaction events
              if (event.$type === "space.roomy.reaction.removeBridgedReaction.v0") {
                await orchestrator.handleRoomyRemoveReaction(decodedEvent, bot).catch((error) => {
                  console.error(`Failed to sync Roomy reaction removal ${event.id} to Discord:`, error);
                });
              }
            }
          }
        }
      }
    }

    // Update cursor to highest idx in batch
    if (maxIdx > 0) {
      await leafCursors.put(spaceId, maxIdx);
    }
  };
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
function extractDiscordMessageOrigin(
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
function extractDiscordOrigin(
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
function extractDiscordUserOrigin(
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
function extractDiscordSidebarOrigin(
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
function extractDiscordRoomLinkOrigin(
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
function extractDiscordReactionOrigin(
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

/**
 * Get the last processed index for a space, or 1 if not found.
 * Leaf stream indices are 1-based, so new subscriptions should start at 1.
 */
export async function getLastProcessedIdx(spaceId: string): Promise<number> {
  try {
    const idx = await leafCursors.get(spaceId);
    return idx ?? 1;
  } catch {
    return 1;
  }
}
