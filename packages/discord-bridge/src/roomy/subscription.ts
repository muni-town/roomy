/**
 * Leaf subscription handler for processing Roomy events.
 *
 * Updates LevelDB state (syncedIds, cursors) based on incoming events.
 * This is the single place where derived state is updated from the
 * source of truth (Leaf event stream).
 */

import type { DecodedStreamEvent, EventCallbackMeta } from "@roomy/sdk";
import { leafCursors, syncedIdsForBridge, registeredBridges } from "../db.js";

/**
 * Extension type key for Discord message origin metadata.
 */
const DISCORD_MESSAGE_ORIGIN_KEY =
  "space.roomy.extension.discordMessageOrigin.v0" as const;

/**
 * Extension type key for Discord room origin metadata.
 */
const DISCORD_ORIGIN_KEY = "space.roomy.extension.discordOrigin.v0" as const;

interface DiscordMessageOrigin {
  snowflake: string;
  channelId: string;
  guildId: string;
}

interface DiscordOrigin {
  snowflake: string;
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
    const guildIdStr = await registeredBridges.get_guildId(spaceId);
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

    for (const { idx, event } of events) {
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
            discordId: roomOrigin.snowflake,
            roomyId: event.id,
          });
        } catch (e) {
          // Already registered - this is fine, idempotent
          if (!(e instanceof Error && e.message.includes("already registered"))) {
            console.error("Error registering synced ID:", e);
          }
        }
      }

      // Check for delete events and unregister mappings
      if (event.$type === "space.roomy.room.deleteRoom.v0") {
        try {
          const discordId = await syncedIds.get_discordId(event.roomId);
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
          const discordId = await syncedIds.get_discordId(event.messageId);
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
    }

    // Update cursor to highest idx in batch
    if (maxIdx > 0) {
      await leafCursors.put(spaceId, maxIdx);
    }
  };
}

/**
 * Extract Discord message origin extension from an event if present.
 */
function extractDiscordMessageOrigin(
  event: DecodedStreamEvent["event"],
): DiscordMessageOrigin | undefined {
  // Message events have extensions at the top level
  const extensions = (event as { extensions?: Record<string, unknown> })
    .extensions;
  if (!extensions) return undefined;

  const origin = extensions[DISCORD_MESSAGE_ORIGIN_KEY] as
    | DiscordMessageOrigin
    | undefined;
  return origin;
}

/**
 * Extract Discord room origin extension from an event if present.
 */
function extractDiscordOrigin(
  event: DecodedStreamEvent["event"],
): DiscordOrigin | undefined {
  // Room events have extensions at the top level
  const extensions = (event as { extensions?: Record<string, unknown> })
    .extensions;
  if (!extensions) return undefined;

  const origin = extensions[DISCORD_ORIGIN_KEY] as DiscordOrigin | undefined;
  return origin;
}

/**
 * Get the last processed index for a space, or 0 if not found.
 */
export async function getLastProcessedIdx(spaceId: string): Promise<number> {
  try {
    const idx = await leafCursors.get(spaceId);
    return idx ?? 0;
  } catch {
    return 0;
  }
}
