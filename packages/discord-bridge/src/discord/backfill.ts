/**
 * Legacy backfill functions - DEPRECATED
 *
 * This file contains legacy backfill implementations that have been
 * migrated to service-based architecture.
 *
 * Use the following instead:
 * - messageSync.backfillToRoomy() - for Discord → Roomy message backfill
 * - reactionSync.backfillToRoomy() - for Discord → Roomy reaction backfill
 * - structureSync.backfillToRoomy() - for Discord → Roomy channel/thread backfill
 */

import type { Message, Emoji } from "@discordeno/bot";
import type { DiscordBot } from "./types";
import type { MessageProperties } from "./types";
import {
  discordMessageHashesForBridge,
  discordWebhookTokensForBridge,
} from "../repositories/LevelDBBridgeRepository.js";
import type { BridgeRepository } from "../repositories/index.js";
import { tracer, setDiscordAttrs, recordError } from "../tracing.js";
import { fingerprint } from "../utils/hash.js";
import { ReactionSyncService } from "../services/ReactionSyncService.js";
import { ConnectedSpace } from "@roomy/sdk";

/**
 * Compute a SHA-256 hash of normalized Discord message content.
 * Used for duplicate detection during Roomy → Discord sync.
 *
 * @param message - Discord message to hash
 * @returns 32-character hex string (first 128 bits of SHA-256)
 */
export async function computeDiscordMessageHash(
  message: Message | MessageProperties,
): Promise<string> {
  const normalized = {
    content: message.content || "",
    attachments:
      message.attachments?.map((a: any) => ({
        filename: a.filename,
        description: a.description,
      })) || [],
  };

  return fingerprint(JSON.stringify(normalized));
}

/**
 * Backfill all Discord messages for a guild's channels.
 * DEPRECATED: Use messageSync.backfillToRoomy() instead.
 *
 * This function builds content hash map for duplicate detection during
 * Roomy → Discord sync.
 *
 * For each message:
 * - If from our webhook: Extract truncated ULID nonce and store ULID → Discord ID mapping
 * - If human message: Compute SHA-256 hash and store with empty prefix
 *
 * @param bot - Discord bot instance
 * @param ctx - Guild context
 * @param channels - Discord channels to backfill
 * @returns Map of channelId → {hash → discordMessageId}
 *
 * @deprecated Use MessageSyncService.backfillToRoomy() instead
 */
export async function backfillDiscordMessages(
  bot: DiscordBot,
  ctx: {
    guildId: bigint;
    repo: BridgeRepository;
    connectedSpace: ConnectedSpace;
  },
  channels: bigint[],
): Promise<Map<string, Map<string, string>>> {
  console.warn(
    "[DEPRECATED] backfillDiscordMessages is deprecated. Use MessageSyncService.backfillToRoomy() instead.",
  );

  return tracer.startActiveSpan("backfill.discord_messages", async (span) => {
    try {
      setDiscordAttrs(span, { guildId: ctx.guildId });
      span.setAttribute("discord.channels.count", channels.length);

      const hashMap = new Map<string, Map<string, string>>();
      const webhookTokens = discordWebhookTokensForBridge({
        discordGuildId: ctx.guildId,
        roomySpaceId: ctx.connectedSpace.streamDid,
      });
      const messageHashes = discordMessageHashesForBridge({
        discordGuildId: ctx.guildId,
        roomySpaceId: ctx.connectedSpace.streamDid,
      });

      // Get our webhook IDs for this guild's channels
      const ourWebhookIds = new Set<string>();
      for (const channelId of channels) {
        try {
          const cached = await webhookTokens.get(channelId.toString());
          if (cached) {
            const parts = cached.split(":");
            const webhookId = parts[0];
            if (webhookId) {
              ourWebhookIds.add(webhookId);
            }
          }
        } catch {
          // No webhook for this channel
        }
      }

      span.setAttribute("discord.webhooks.count", ourWebhookIds.size);

      // Backfill messages for each channel
      for (const channelId of channels) {
        await tracer.startActiveSpan(
          "backfill.channel_messages",
          async (channelSpan) => {
            try {
              setDiscordAttrs(channelSpan, { channelId });
              const channelHashes = new Map<string, string>();
              let messageCount = 0;
              let webhookNonceCount = 0;
              let humanMessageCount = 0;

              // Fetch messages with pagination (oldest first)
              let before: bigint | undefined;
              while (true) {
                const messages = await bot.helpers.getMessages(channelId, {
                  before,
                  limit: 100,
                });

                if (messages.length === 0) break;

                // Process oldest first (API returns newest first)
                const sortedMessages = [...messages].reverse();
                for (const message of sortedMessages) {
                  const messageIdStr = message.id.toString();

                  // Check if message is from our webhook
                  if (
                    message.webhookId &&
                    ourWebhookIds.has(message.webhookId.toString())
                  ) {
                    // Webhook message - extract nonce (truncated ULID)
                    // Nonce format: truncated Roomy event ULID (25 chars)
                    const nonce = (message as any).nonce;
                    if (
                      nonce &&
                      typeof nonce === "string" &&
                      nonce.length <= 25
                    ) {
                      // Store ULID → Discord ID mapping
                      await ctx.repo.registerMapping(nonce, messageIdStr);
                      webhookNonceCount++;

                      // Also compute hash with nonce prefix for deduplication
                      const hash = await computeDiscordMessageHash(message);
                      const key = `${nonce}:${hash}`;
                      channelHashes.set(key, messageIdStr);
                    }
                  } else {
                    // Human message - compute hash with empty prefix
                    const hash = await computeDiscordMessageHash(message);
                    const key = `:${hash}`; // Empty prefix for human messages
                    channelHashes.set(key, messageIdStr);
                    humanMessageCount++;
                  }

                  messageCount++;
                  before = message.id;
                }

                channelSpan.setAttribute(
                  "discord.messages.count",
                  messageCount,
                );
              }

              // Store channel hashes in database
              const allHashes: Record<string, string> = {};
              for (const [key, messageId] of channelHashes) {
                allHashes[key] = messageId;
              }
              await messageHashes.put("hashes", allHashes);

              hashMap.set(channelId.toString(), channelHashes);

              console.log(
                `Backfilled ${messageCount} messages for channel ${channelId}: ` +
                  `${webhookNonceCount} webhook nonces, ${humanMessageCount} human messages`,
              );
              channelSpan.setAttribute("sync.result", "success");
            } catch (error) {
              recordError(channelSpan, error);
              throw error;
            } finally {
              channelSpan.end();
            }
          },
        );
      }

      span.setAttribute("sync.result", "success");
      return hashMap;
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Backfill all reactions for Discord messages.
 * DEPRECATED: Use reactionSync.backfillToRoomy() instead.
 *
 * Fetches all messages in a channel, finds all reactions on each message,
 * and syncs each user's reaction to Roomy.
 *
 * @param bot - Discord bot instance
 * @param ctx - Guild context
 * @param channelId - Discord channel ID
 *
 * @deprecated Use ReactionSyncService.backfillToRoomy() instead
 */
export async function backfillDiscordReactions(
  bot: DiscordBot,
  ctx: {
    guildId: bigint;
    repo: BridgeRepository;
    connectedSpace: ConnectedSpace;
  },
  channelId: bigint,
): Promise<void> {
  console.warn(
    "[DEPRECATED] backfillDiscordReactions is deprecated. Use ReactionSyncService.backfillToRoomy() instead.",
  );

  return tracer.startActiveSpan("backfill.discord_reactions", async (span) => {
    try {
      setDiscordAttrs(span, { guildId: ctx.guildId, channelId });

      let reactionCount = 0;
      let messageCount = 0;

      // Use the repo from OrchestratorContext
      const repo = ctx.repo;

      // Create ReactionSyncService
      // Note: This uses the old API signature - backfillToRoomy() is preferred
      const reactionSync = new ReactionSyncService(
        repo,
        ctx.connectedSpace.streamDid,
        // dispatcher is not available here, create a minimal one
        null as any,
        ctx.guildId,
        bot,
      );

      // Fetch messages with pagination to get their reactions
      let before: bigint | undefined;
      while (true) {
        const messages = await bot.helpers.getMessages(channelId, {
          before,
          limit: 100,
        });

        if (messages.length === 0) break;

        messageCount += messages.length;

        // Process each message's reactions
        for (const message of messages) {
          // REST API populates the reactions property
          const reactions = (message as unknown as { reactions?: unknown[] })
            .reactions;
          if (!reactions || reactions.length === 0) {
            continue;
          }

          // For each reaction type, fetch the users who reacted
          for (const reaction of reactions) {
            if (!reaction || typeof reaction !== "object") continue;

            const emoji = (reaction as { emoji?: Partial<Emoji> }).emoji;
            if (!emoji) continue;

            const count = (reaction as { count?: number }).count || 1;

            // Fetch all users who reacted with this emoji (with pagination)
            let after: string | undefined;
            let hasMore = true;

            while (hasMore) {
              // Build emoji string for API call
              // Unicode emoji: just use the string
              // Custom emoji: Discord uses format "name:id"
              let emojiString = emoji.name || "";
              if (emoji.id) {
                emojiString = `${emoji.name}:${emoji.id}`;
              }

              // Fetch users who reacted (max 100 per request)
              const options: { limit: number; after?: string } = { limit: 100 };
              if (after) {
                options.after = after;
              }
              const users = await bot.helpers.getReactions(
                channelId,
                message.id,
                emojiString,
                options as any,
              );

              if (users.length === 0) {
                hasMore = false;
                break;
              }

              // Sync each user's reaction to Roomy
              for (const user of users) {
                const reactionEventId = await reactionSync.syncAddToRoomy(
                  message.id,
                  channelId,
                  user.id,
                  emoji,
                );

                if (reactionEventId) {
                  reactionCount++;
                }
              }

              // Check if there are more users to fetch
              if (users.length < 100) {
                hasMore = false;
              } else {
                // Set cursor to last user's ID for next page
                after = users[users.length - 1]?.id?.toString();
              }
            }
          }

          // Update cursor for message pagination
          before = message.id;
        }

        // Check if we've fetched all messages
        if (messages.length < 100) break;
      }

      console.log(
        `Backfilled ${reactionCount} reactions from ${messageCount} messages on channel ${channelId}`,
      );
      span.setAttribute("sync.result", "success");
      span.setAttribute("reaction.count", reactionCount);
      span.setAttribute("message.count", messageCount);
    } catch (error) {
      recordError(span, error);
      console.error(
        `Error backfilling reactions for channel ${channelId}:`,
        error,
      );
      // Don't throw - reactions are optional
      span.setAttribute("sync.result", "partial");
    } finally {
      span.end();
    }
  });
}
