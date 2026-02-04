/**
 * Backfill Roomy → Discord sync for messages.
 * Implements Phase 1 (Roomy timeline backfill) and Phase 3 (Roomy → Discord sync).
 */

import type { DecodedStreamEvent, Event } from "@roomy/sdk";
import { StreamIndex } from "@roomy/sdk";
import type { DiscordBot } from "../discord/types.js";
import { registeredBridges, roomyUserProfilesForBridge } from "../db.js";
import { GuildContext } from "../types.js";
import { tracer, setDiscordAttrs, setRoomyAttrs, recordError } from "../tracing.js";
import { DISCORD_EXTENSION_KEYS } from "./subscription.js";
import { getRoomKey } from "./to.js";
import {
  backfillDiscordMessages,
  computeDiscordMessageHash,
} from "../discord/backfill.js";
import {
  getOrCreateWebhook,
  executeWebhookWithRetry,
  clearWebhookCache,
} from "../discord/webhooks.js";

// Helper to decode message body data
function decodeMessageBody(event: Event): string {
  const createMessageEvent = event as { body?: { data: { $bytes?: string } | Uint8Array } };
  const data = createMessageEvent.body?.data;
  if (!data) return "";
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  const bytesData = data as { $bytes?: string };
  if (bytesData.$bytes) return atob(bytesData.$bytes);
  return "";
}
/**
 * Fetch Roomy-origin events (skip Discord-origin events).
 * Uses ConnectedSpace to fetch all events and filters for those without Discord origin extensions.
 *
 * @param ctx - Guild context containing ConnectedSpace
 * @param start - Starting stream index (default: 1)
 * @param limit - Maximum events to fetch per batch (default: 2500)
 * @returns Array of Roomy-origin events
 */
export async function fetchRoomyOriginEvents(
  ctx: GuildContext,
  start: StreamIndex = 1 as StreamIndex,
  limit: number = 2500,
): Promise<DecodedStreamEvent[]> {
  return tracer.startActiveSpan(
    "fetch.roomy_origin_events",
    async (span) => {
      try {
        setRoomyAttrs(span, { spaceId: ctx.spaceId });
        span.setAttribute("stream.start", start);
        span.setAttribute("stream.limit", limit);

        // Fetch all events from the space
        const events = await ctx.connectedSpace.fetchEvents(start, limit);

        // Filter out Discord-origin events
        const roomyOriginEvents = events.filter(({ event }) => {
          const extensions = (event as { extensions?: Record<string, unknown> }).extensions;
          // Check for Discord message origin extension
          if (extensions?.[DISCORD_EXTENSION_KEYS.MESSAGE_ORIGIN]) {
            return false;
          }

          // Check for Discord room origin extension
          if (extensions?.[DISCORD_EXTENSION_KEYS.ROOM_ORIGIN]) {
            return false;
          }

          // Check for Discord user origin extension
          if (extensions?.[DISCORD_EXTENSION_KEYS.USER_ORIGIN]) {
            return false;
          }

          // Check for Discord sidebar origin extension
          if (extensions?.[DISCORD_EXTENSION_KEYS.SIDEBAR_ORIGIN]) {
            return false;
          }

          // Check for Discord room link origin extension
          if (extensions?.[DISCORD_EXTENSION_KEYS.ROOM_LINK_ORIGIN]) {
            return false;
          }

          // Check for Discord reaction origin extension
          if (extensions?.[DISCORD_EXTENSION_KEYS.REACTION_ORIGIN]) {
            return false;
          }

          return true;
        });

        span.setAttribute("sync.result", "success");
        span.setAttribute("events.total", events.length);
        span.setAttribute("events.roomy_origin", roomyOriginEvents.length);

        return roomyOriginEvents;
      } catch (error) {
        recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Sync Roomy events to Discord (Phase 3).
 * Processes Roomy-origin events and sends them to Discord via webhooks.
 *
 * Three-phase algorithm:
 * 1. Truncate ULID to 25 chars for Discord nonce
 * 2. Check if already synced via syncedIds lookup
 * 3. Compute hash and check discordMessageHashes for duplicates
 * 4. Send via webhook with nonce if not duplicate
 *
 * @param ctx - Guild context
 * @param bot - Discord bot instance
 * @param roomyEvents - Roomy-origin events to sync
 * @param discordHashes - Discord message hashes for duplicate detection (channelId → {hash → messageId})
 */
export async function syncRoomyToDiscord(
  ctx: GuildContext,
  bot: DiscordBot,
  roomyEvents: DecodedStreamEvent[],
  discordHashes: Map<string, Map<string, string>>,
): Promise<void> {
  return tracer.startActiveSpan("sync.roomy_to_discord", async (span) => {
    try {
      setDiscordAttrs(span, { guildId: ctx.guildId });
      setRoomyAttrs(span, { spaceId: ctx.spaceId });
      span.setAttribute("roomy.events.count", roomyEvents.length);

      let syncedCount = 0;
      let skippedCount = 0;
      let duplicateCount = 0;
      let errorCount = 0;

      for (const { event, user } of roomyEvents) {
        // Only process createMessage events initially
        if (event.$type !== "space.roomy.message.createMessage.v0") {
          skippedCount++;
          continue;
        }

        try {
          await tracer.startActiveSpan(
            "sync.roomy_message",
            async (eventSpan) => {
              try {
                setRoomyAttrs(eventSpan, { eventId: event.id });

                // Get the Discord channel ID for this room
                const roomyRoomId = (event as { room?: string }).room;
                if (!roomyRoomId) {
                  eventSpan.setAttribute("sync.result", "skipped_no_room");
                  skippedCount++;
                  return;
                }

                const discordId = await ctx.syncedIds.get_discordId(
                  getRoomKey(roomyRoomId),
                );
                if (!discordId) {
                  eventSpan.setAttribute(
                    "sync.result",
                    "skipped_channel_not_synced",
                  );
                  skippedCount++;
                  return;
                }

                const channelId = BigInt(
                  discordId.replace("room:", ""),
                ) as bigint;

                setDiscordAttrs(eventSpan, { channelId });

                // Phase 1: Truncate ULID to 25 chars for Discord nonce
                const nonce = event.id.slice(0, 25);

                // Phase 2: Check if already synced
                const existingDiscordId = await ctx.syncedIds.get_discordId(
                  nonce,
                );
                if (existingDiscordId) {
                  eventSpan.setAttribute("sync.result", "skipped_already_synced");
                  skippedCount++;
                  return;
                }

                // Phase 3: Compute hash for duplicate detection
                const content = decodeMessageBody(event);
                const extensions = (event as { extensions?: Record<string, unknown> }).extensions || {};
                const attachmentsExt = extensions["space.roomy.extension.attachments.v0"] as { attachments?: unknown[] } | undefined;
                const attachments = attachmentsExt?.attachments || [];

                // Create a simple object for hash computation (type hack for computeDiscordMessageHash)
                const hash = await computeDiscordMessageHash({
                  content,
                  attachments: attachments.map((a: any) => ({
                    filename: a.name || a.filename,
                    description: a.description,
                  })),
                } as any);

                // Phase 4: Check if content already exists on Discord
                const channelHashes = discordHashes.get(channelId.toString());
                if (channelHashes) {
                  const lookupKey = `${nonce}:${hash}`;
                  const existingMessageId = channelHashes.get(lookupKey);
                  if (existingMessageId) {
                    // Content already exists on Discord - register mapping and skip
                    await ctx.syncedIds.register({
                      discordId: nonce,
                      roomyId: existingMessageId,
                    });
                    eventSpan.setAttribute("sync.result", "skipped_duplicate");
                    duplicateCount++;
                    return;
                  }
                }

                // Phase 5: Send via webhook
                const webhook = await tracer.startActiveSpan(
                  "webhook.get_or_create",
                  async (webhookSpan) => {
                    try {
                      return await getOrCreateWebhook(bot, ctx, channelId);
                    } catch (error) {
                      recordError(webhookSpan, error);
                      throw error;
                    } finally {
                      webhookSpan.end();
                    }
                  },
                );

                // Extract author info for puppeting
                // For bridged messages, use authorOverride.did; for pure Roomy messages, use event.user
                const authorOverride = extensions["space.roomy.extension.authorOverride.v0"] as { did?: string } | undefined;
                const authorDid = authorOverride?.did || user;

                // Get username/avatar from DID
                let username = "Roomy User";
                let avatarUrl: string | undefined;

                // Check if it's a Discord user
                const discordMatch = authorDid.match(/did:discord:(\d+)/);
                if (discordMatch) {
                  username = `Roomy User ${discordMatch[1]}`;
                  // Could fetch user info from Discord API here for avatar
                } else {
                  // It's a Roomy user - try to get their profile from cache
                  const roomyProfiles = roomyUserProfilesForBridge({
                    discordGuildId: ctx.guildId,
                    roomySpaceId: ctx.spaceId,
                  });
                  try {
                    const profile = await roomyProfiles.get(authorDid);
                    if (profile) {
                      username = profile.name;
                      avatarUrl = profile.avatar ?? undefined;
                    }
                  } catch {
                    // Profile not found - use defaults
                  }
                }

                // Build webhook message
                const webhookMessage = {
                  content,
                  username,
                  avatarUrl,
                  nonce,
                } as const;

                const result = await tracer.startActiveSpan(
                  "webhook.execute",
                  async (execSpan) => {
                    try {
                      return await executeWebhookWithRetry(
                        bot,
                        webhook.id,
                        webhook.token,
                        webhookMessage,
                      );
                    } catch (error: any) {
                      recordError(execSpan, error);
                      // If webhook was deleted (404), clear cache and retry
                      if (
                        error?.code === 404 ||
                        (error as any)?.metadata?.code === 404
                      ) {
                        await clearWebhookCache(ctx, channelId);
                        const newWebhook = await getOrCreateWebhook(
                          bot,
                          ctx,
                          channelId,
                        );
                        return await executeWebhookWithRetry(
                          bot,
                          newWebhook.id,
                          newWebhook.token,
                          webhookMessage,
                        );
                      }
                      throw error;
                    } finally {
                      execSpan.end();
                    }
                  },
                );

                if (result) {
                  // Register the Discord snowflake → Roomy ULID mapping (for reaction sync)
                  await ctx.syncedIds.register({
                    discordId: result.id.toString(),
                    roomyId: event.id,
                  });

                  // Also register the truncated nonce mapping (for idempotency check)
                  await ctx.syncedIds.register({
                    discordId: nonce,
                    roomyId: result.id.toString(),
                  });

                  syncedCount++;
                  eventSpan.setAttribute("sync.result", "success");
                  eventSpan.setAttribute("discord.message.id", result.id.toString());
                }
              } catch (error) {
                recordError(eventSpan, error);
                errorCount++;
              } finally {
                eventSpan.end();
              }
            },
          );
        } catch (error) {
          console.error(`Error syncing event ${event.id}:`, error);
          errorCount++;
        }
      }

      span.setAttribute("sync.result", "success");
      span.setAttribute("sync.messages.synced", syncedCount);
      span.setAttribute("sync.messages.skipped", skippedCount);
      span.setAttribute("sync.messages.duplicate", duplicateCount);
      span.setAttribute("sync.messages.error", errorCount);

      console.log(
        `Roomy → Discord sync complete: ${syncedCount} synced, ${skippedCount} skipped, ${duplicateCount} duplicate, ${errorCount} error`,
      );
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Main backfill function for Roomy → Discord sync.
 * Orchestrates the three-phase backfill process.
 *
 * Phase 1: Fetch Roomy-origin events
 * Phase 2: Backfill Discord messages for hash computation
 * Phase 3: Sync Roomy events to Discord with duplicate detection
 *
 * @param bot - Discord bot instance
 */
export async function backfillRoomyToDiscord(bot: DiscordBot): Promise<void> {
  return tracer.startActiveSpan("backfill.roomy_to_discord", async (span) => {
    try {
      span.setAttribute("sync.phase", "orchestration");

      // Get all registered bridges
      const bridges = await registeredBridges.list();
      span.setAttribute("bridges.count", bridges.length);

      for (const bridge of bridges) {
        const guildId = BigInt(bridge.guildId);
        const spaceId = bridge.spaceId;

        await tracer.startActiveSpan(
          "backfill.bridge",
          async (bridgeSpan) => {
            try {
              setDiscordAttrs(bridgeSpan, { guildId });
              setRoomyAttrs(bridgeSpan, { spaceId });

              // Get guild context
              const { getGuildContext } = await import("../discord/bot.js");
              const ctx = await getGuildContext(guildId);
              if (!ctx) {
                console.warn(`No context for guild ${guildId}, skipping`);
                return;
              }

              // Get all Discord channels for this guild
              const channels = await bot.helpers.getChannels(guildId);
              const textChannels = channels
                .filter((c) => c.type === 0) // GuildText
                .map((c) => c.id);

              // Phase 1: Fetch Roomy-origin events
              bridgeSpan.setAttribute("sync.phase", "1_fetch_roomy_events");
              const roomyEvents = await fetchRoomyOriginEvents(ctx);
              console.log(
                `Fetched ${roomyEvents.length} Roomy-origin events for space ${spaceId}`,
              );

              // Phase 2: Backfill Discord messages for hash computation
              bridgeSpan.setAttribute("sync.phase", "2_backfill_discord");
              const discordHashes = await backfillDiscordMessages(
                bot,
                ctx,
                textChannels,
              );
              console.log(
                `Backfilled Discord messages for ${textChannels.length} channels`,
              );

              // Phase 3: Sync Roomy events to Discord
              bridgeSpan.setAttribute("sync.phase", "3_sync_to_discord");
              await syncRoomyToDiscord(ctx, bot, roomyEvents, discordHashes);

              bridgeSpan.setAttribute("sync.result", "success");
            } catch (error) {
              recordError(bridgeSpan, error);
              throw error;
            } finally {
              bridgeSpan.end();
            }
          },
        );
      }

      span.setAttribute("sync.result", "success");
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
