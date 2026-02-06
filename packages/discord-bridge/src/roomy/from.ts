/**
 * Roomy → Discord sync handlers for real-time events.
 * Processes Roomy-origin events and sends them to Discord.
 */

import type { DecodedStreamEvent, Event, Did } from "@roomy/sdk";
import { getProfile } from "@roomy/sdk";
import type { DiscordBot } from "../discord/types.js";
import { GuildContext } from "../types.js";
import { tracer, setDiscordAttrs, setRoomyAttrs, recordError } from "../tracing.js";
import { DISCORD_EXTENSION_KEYS } from "./subscription.js";
import {
  getOrCreateWebhook,
  executeWebhookWithRetry,
  clearWebhookCache,
} from "../discord/webhooks.js";
import { computeDiscordMessageHash } from "../discord/backfill.js";
import { roomyUserProfilesForBridge } from "../db.js";
import { getRoomyClient } from "./client.js";
import { decodeMessageBody } from "../utils/message.js";

/**
 * Sync a Roomy createMessage event to Discord.
 * Sends the message via webhook with nonce for idempotency.
 *
 * @param ctx - Guild context
 * @param bot - Discord bot instance
 * @param decodedEvent - Decoded Roomy event
 */
export async function syncCreateMessageToDiscord(
  ctx: GuildContext,
  bot: DiscordBot,
  decodedEvent: DecodedStreamEvent,
): Promise<void> {
  const { event } = decodedEvent;

  return tracer.startActiveSpan("sync.createMessage.roomy_to_discord", async (span) => {
    try {
      setRoomyAttrs(span, { eventId: event.id });
      setDiscordAttrs(span, { guildId: ctx.guildId });

      // Get the Discord channel ID for this room
      const roomyRoomId = (event as { room?: string }).room;
      if (!roomyRoomId) {
        span.setAttribute("sync.result", "skipped_no_room");
        return;
      }

      // Look up Discord channel ID from Roomy room ID (result contains "room:" prefix)
      const discordId = await ctx.syncedIds.get_roomyId(roomyRoomId);
      if (!discordId) {
        span.setAttribute("sync.result", "skipped_channel_not_synced");
        console.warn(`Roomy room ${roomyRoomId} not synced to Discord, skipping message`);
        return;
      }

      const channelId = BigInt(discordId.replace("room:", ""));
      setDiscordAttrs(span, { channelId });

      // Truncate ULID to 25 chars for Discord nonce
      const nonce = event.id.slice(0, 25);

      // Check if already synced
      const existingDiscordId = await ctx.syncedIds.get_discordId(nonce);
      if (existingDiscordId) {
        span.setAttribute("sync.result", "skipped_already_synced");
        return;
      }

      // Decode content
      const content = decodeMessageBody(event);

      // Get attachments
      const extensions = (event as { extensions?: Record<string, unknown> }).extensions || {};
      const attachmentsExt = extensions["space.roomy.extension.attachments.v0"] as { attachments?: unknown[] } | undefined;
      const attachments = attachmentsExt?.attachments || [];

      // Get webhook
      const webhook = await tracer.startActiveSpan("webhook.get_or_create", async (webhookSpan) => {
        try {
          return await getOrCreateWebhook(bot, ctx.guildId, ctx.spaceId, channelId);
        } catch (error) {
          recordError(webhookSpan, error);
          throw error;
        } finally {
          webhookSpan.end();
        }
      });

      // Extract author info for puppeting
      // For bridged messages, use authorOverride.did; for pure Roomy messages, use decodedEvent.user
      const authorOverride = extensions["space.roomy.extension.authorOverride.v0"] as { did?: string } | undefined;
      const authorDid = authorOverride?.did || decodedEvent.user;

      console.log(`[Profile Puppeting] Event ${event.id}: authorOverride.did = ${authorOverride?.did || "NOT FOUND"}, using DID: ${authorDid}`);

      // Get username/avatar from DID
      let username = "Roomy User";
      let avatarUrl: string | undefined;

      // Check if it's a Discord user
      const discordMatch = authorDid.match(/did:discord:(\d+)/);
      if (discordMatch) {
        username = `Roomy User ${discordMatch[1]}`;
        console.log(`[Profile Puppeting] Event ${event.id}: Discord user detected, using username: ${username}`);
        // Could fetch user info from Discord API here for avatar
      } else {
        // It's a Roomy user - try to get their profile from cache first
        console.log(`[Profile Puppeting] Event ${event.id}: Roomy user detected (${authorDid}), looking up profile...`);
        const roomyProfiles = roomyUserProfilesForBridge({
          discordGuildId: ctx.guildId,
          roomySpaceId: ctx.spaceId,
        });
        try {
          let profile = await roomyProfiles.get(authorDid);
          if (!profile) {
            // Profile not in cache - fetch from ATProto
            console.log(`[Profile Puppeting] Event ${event.id}: Profile not cached, fetching from ATProto for ${authorDid}...`);
            try {
              const roomyClient = getRoomyClient();
              // Cast authorDid to Did type (branded string)
              const atpProfile = await getProfile(roomyClient.agent, authorDid as Did);
              if (atpProfile) {
                profile = {
                  name: atpProfile.displayName || atpProfile.handle,
                  avatar: atpProfile.avatar ?? null,
                  handle: atpProfile.handle,
                };
                // Cache the profile
                await roomyProfiles.put(authorDid, profile);
                console.log(`[Profile Puppeting] Event ${event.id}: Fetched and cached profile - name: ${profile.name}, avatar: ${profile.avatar || "none"}`);
              }
            } catch (e) {
              console.error(`[Profile Puppeting] Event ${event.id}: Failed to fetch profile from ATProto:`, e);
            }
          }

          if (profile) {
            username = profile.name;
            avatarUrl = profile.avatar ?? undefined;
            console.log(`[Profile Puppeting] Event ${event.id}: Using profile - name: ${username}, avatar: ${avatarUrl || "none"}`);
          } else {
            console.warn(`[Profile Puppeting] Event ${event.id}: No profile available for ${authorDid}, using default username`);
          }
        } catch (e) {
          console.error(`[Profile Puppeting] Event ${event.id}: Error getting profile for DID ${authorDid}:`, e);
        }
      }

      // Build webhook message
      const webhookMessage = {
        content,
        username,
        avatarUrl,
        nonce,
      } as const;

      // Execute webhook with retry
      const result = await tracer.startActiveSpan("webhook.execute", async (execSpan) => {
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
          if (error?.code === 404 || error?.metadata?.code === 404) {
            await clearWebhookCache(ctx.guildId, ctx.spaceId, channelId);
            const newWebhook = await getOrCreateWebhook(bot, ctx.guildId, ctx.spaceId, channelId);
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
      });

      if (result) {
        // Register bidirectional mapping between Discord snowflake and Roomy ULID
        await ctx.syncedIds.register({
          discordId: result.id.toString(),  // Discord snowflake
          roomyId: event.id,                 // Roomy ULID
        });

        // Also register the truncated nonce mapping (for idempotency check)
        // Maps nonce → Discord snowflake so we can check if already synced
        await ctx.syncedIds.register({
          discordId: nonce,
          roomyId: result.id.toString(),
        });

        console.log(`Synced Roomy message ${event.id} to Discord ${result.id}`);
        console.log(`[Webhook Registration] Registered mapping: discordId=${result.id} → roomyId=${event.id}`);
        span.setAttribute("sync.result", "success");
        span.setAttribute("discord.message.id", result.id.toString());
      } else {
        console.error(`[Webhook Registration] No result from webhook execution for event ${event.id}`);
      }
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Sync a Roomy editMessage event to Discord.
 * Edits the existing Discord message.
 *
 * @param ctx - Guild context
 * @param bot - Discord bot instance
 * @param decodedEvent - Decoded Roomy event
 */
export async function syncEditMessageToDiscord(
  ctx: GuildContext,
  bot: DiscordBot,
  decodedEvent: DecodedStreamEvent,
): Promise<void> {
  const { event } = decodedEvent;

  return tracer.startActiveSpan("sync.editMessage.roomy_to_discord", async (span) => {
    try {
      setRoomyAttrs(span, { eventId: event.id });
      setDiscordAttrs(span, { guildId: ctx.guildId });

      const editEvent = event as {
        messageId: string;
        body?: { data: Uint8Array };
      };

      // Get the Discord message ID from the Roomy message ID
      const discordId = await ctx.syncedIds.get_discordId(editEvent.messageId);
      if (!discordId) {
        span.setAttribute("sync.result", "skipped_not_synced");
        return;
      }

      const discordMessageId = BigInt(discordId);

      // Get the room ID from the event
      const roomyRoomId = (event as { room?: string }).room;
      if (!roomyRoomId) {
        span.setAttribute("sync.result", "skipped_no_room");
        return;
      }

      // Get the Discord channel ID
      const channelIdStr = await ctx.syncedIds.get_roomyId(roomyRoomId);
      if (!channelIdStr) {
        span.setAttribute("sync.result", "skipped_channel_not_synced");
        return;
      }

      const channelId = BigInt(channelIdStr.replace("room:", ""));
      setDiscordAttrs(span, { channelId });

      // Decode content
      const content = editEvent.body ? decodeMessageBody(editEvent as Event) : "";

      // Edit the message
      await bot.helpers.editMessage(channelId, discordMessageId, { content });

      console.log(`Synced edit for Roomy message ${editEvent.messageId} to Discord ${discordMessageId}`);
      span.setAttribute("sync.result", "success");
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Sync a Roomy deleteMessage event to Discord.
 * Deletes the Discord message.
 *
 * @param ctx - Guild context
 * @param bot - Discord bot instance
 * @param decodedEvent - Decoded Roomy event
 */
export async function syncDeleteMessageToDiscord(
  ctx: GuildContext,
  bot: DiscordBot,
  decodedEvent: DecodedStreamEvent,
): Promise<void> {
  const { event } = decodedEvent;

  return tracer.startActiveSpan("sync.deleteMessage.roomy_to_discord", async (span) => {
    try {
      setRoomyAttrs(span, { eventId: event.id });
      setDiscordAttrs(span, { guildId: ctx.guildId });

      const deleteEvent = event as { messageId: string };

      // Get the Discord message ID from the Roomy message ID
      const discordId = await ctx.syncedIds.get_discordId(deleteEvent.messageId);
      if (!discordId) {
        span.setAttribute("sync.result", "skipped_not_synced");
        return;
      }

      const discordMessageId = BigInt(discordId);

      // Get the room ID from the event
      const roomyRoomId = (event as { room?: string }).room;
      if (!roomyRoomId) {
        span.setAttribute("sync.result", "skipped_no_room");
        return;
      }

      // Get the Discord channel ID
      const channelIdStr = await ctx.syncedIds.get_roomyId(roomyRoomId);
      if (!channelIdStr) {
        span.setAttribute("sync.result", "skipped_channel_not_synced");
        return;
      }

      const channelId = BigInt(channelIdStr.replace("room:", ""));
      setDiscordAttrs(span, { channelId });

      // Delete the message
      await bot.helpers.deleteMessage(channelId, discordMessageId);

      console.log(`Synced delete for Roomy message ${deleteEvent.messageId} to Discord ${discordMessageId}`);
      span.setAttribute("sync.result", "success");
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Sync a Roomy addBridgedReaction or addReaction event to Discord.
 * Adds a reaction to the Discord message.
 *
 * Handles both:
 * - space.roomy.reaction.addBridgedReaction.v0 (with reactingUser field)
 * - space.roomy.reaction.addReaction.v0 (user from DecodedStreamEvent)
 *
 * @param ctx - Guild context
 * @param bot - Discord bot instance
 * @param decodedEvent - Decoded Roomy event
 */
export async function syncAddReactionToDiscord(
  ctx: GuildContext,
  bot: DiscordBot,
  decodedEvent: DecodedStreamEvent,
): Promise<void> {
  const { event, user } = decodedEvent;

  return tracer.startActiveSpan("sync.addReaction.roomy_to_discord", async (span) => {
    try {
      setRoomyAttrs(span, { eventId: event.id });
      setDiscordAttrs(span, { guildId: ctx.guildId });

      // Handle both addBridgedReaction (with reactingUser) and addReaction (user from event)
      const isBridgedReaction = event.$type === "space.roomy.reaction.addBridgedReaction.v0";
      const reactionEvent = event as {
        reactionTo: string;
        reaction: string;
        reactingUser?: string; // Only present for bridged reactions
      };

      // For pure Roomy reactions, use the event user; for bridged, use reactingUser
      const reactingUser = reactionEvent.reactingUser ?? user;

      // Get the Discord message ID from the Roomy message ID
      // Use get_roomyId() to get the Discord snowflake from the Roomy ULID
      const discordId = await ctx.syncedIds.get_roomyId(reactionEvent.reactionTo);
      if (!discordId) {
        span.setAttribute("sync.result", "skipped_not_synced");
        console.warn(`Roomy message ${reactionEvent.reactionTo} not synced to Discord, skipping reaction`);
        return;
      }

      const discordMessageId = BigInt(discordId);

      // Get the room ID from the event
      const roomyRoomId = (event as { room?: string }).room;
      if (!roomyRoomId) {
        span.setAttribute("sync.result", "skipped_no_room");
        return;
      }

      // Get the Discord channel ID
      const channelIdStr = await ctx.syncedIds.get_roomyId(roomyRoomId);
      if (!channelIdStr) {
        span.setAttribute("sync.result", "skipped_channel_not_synced");
        return;
      }

      const channelId = BigInt(channelIdStr.replace("room:", ""));
      setDiscordAttrs(span, { channelId });

      // Parse the reaction (handle both custom and unicode emojis)
      const reaction = reactionEvent.reaction;
      let emojiName: string | undefined;
      let emojiId: bigint | undefined;

      // Custom emoji format: <:name:id> or <a:name:id>
      const customEmojiMatch = reaction.match(/^<?(a)?:(\w+):(\d+)>?$/);
      if (customEmojiMatch) {
        emojiName = customEmojiMatch[2];
        if (customEmojiMatch[3]) {
          emojiId = BigInt(customEmojiMatch[3]!);
        }
      } else {
        // Unicode emoji - use reaction string directly
        emojiName = reaction;
      }

      if (!emojiName) {
        span.setAttribute("sync.result", "skipped_invalid_emoji");
        return;
      }

      // Add the reaction - use string format for emoji
      const emojiString = emojiId ? `${emojiName}:${emojiId.toString()}` : emojiName;
      await bot.helpers.addReaction(channelId, discordMessageId, emojiString);

      console.log(`Synced reaction ${reaction} to Discord message ${discordMessageId}`);
      span.setAttribute("sync.result", "success");
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Sync a Roomy removeBridgedReaction event to Discord.
 * Removes a reaction from the Discord message.
 *
 * @param ctx - Guild context
 * @param bot - Discord bot instance
 * @param decodedEvent - Decoded Roomy event
 */
export async function syncRemoveReactionToDiscord(
  ctx: GuildContext,
  bot: DiscordBot,
  decodedEvent: DecodedStreamEvent,
): Promise<void> {
  const { event } = decodedEvent;

  return tracer.startActiveSpan("sync.removeReaction.roomy_to_discord", async (span) => {
    try {
      setRoomyAttrs(span, { eventId: event.id });
      setDiscordAttrs(span, { guildId: ctx.guildId });

      const reactionEvent = event as {
        reactionId: string;
        reactingUser: string;
      };

      // The reactionId is the Roomy event ID - we need to find the original reaction
      // For now, we'll need to track which Discord message this was for
      // This is a limitation - we'd need to store more metadata

      // Get the room ID from the event
      const roomyRoomId = (event as { room?: string }).room;
      if (!roomyRoomId) {
        span.setAttribute("sync.result", "skipped_no_room");
        return;
      }

      // Get the Discord channel ID
      const channelIdStr = await ctx.syncedIds.get_roomyId(roomyRoomId);
      if (!channelIdStr) {
        span.setAttribute("sync.result", "skipped_channel_not_synced");
        return;
      }

      const channelId = BigInt(channelIdStr.replace("room:", ""));
      setDiscordAttrs(span, { channelId });

      // TODO: Need to track which message and reaction this maps to
      // For now, skip reaction removal
      console.warn(`Reaction removal not yet implemented for Roomy → Discord sync`);
      span.setAttribute("sync.result", "skipped_not_implemented");
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
