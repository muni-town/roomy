import type { Message } from "@discordeno/bot";
import type { DiscordBot } from "./types";
import type { MessageProperties } from "./types";
import {
  discordMessageHashesForBridge,
  discordWebhookTokensForBridge,
} from "../db.js";
import { GuildContext } from "../types.js";
import { tracer, setDiscordAttrs, recordError } from "../tracing.js";
import { DISCORD_EXTENSION_KEYS } from "../roomy/subscription.js";
import { getRoomKey, fingerprint } from "../roomy/to.js";

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
 * Builds content hash map for duplicate detection during Roomy → Discord sync.
 *
 * For each message:
 * - If from our webhook: Extract truncated ULID nonce and store ULID → Discord ID mapping
 * - If human message: Compute SHA-256 hash and store with empty prefix
 *
 * @param bot - Discord bot instance
 * @param ctx - Guild context
 * @param channels - Discord channels to backfill
 * @returns Map of channelId → {hash → discordMessageId}
 */
export async function backfillDiscordMessages(
  bot: DiscordBot,
  ctx: GuildContext,
  channels: bigint[],
): Promise<Map<string, Map<string, string>>> {
  return tracer.startActiveSpan(
    "backfill.discord_messages",
    async (span) => {
      try {
        setDiscordAttrs(span, { guildId: ctx.guildId });
        span.setAttribute("discord.channels.count", channels.length);

        const hashMap = new Map<string, Map<string, string>>();
        const webhookTokens = discordWebhookTokensForBridge({
          discordGuildId: ctx.guildId,
          roomySpaceId: ctx.spaceId,
        });
        const messageHashes = discordMessageHashesForBridge({
          discordGuildId: ctx.guildId,
          roomySpaceId: ctx.spaceId,
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
                      if (nonce && typeof nonce === "string" && nonce.length <= 25) {
                        // Store ULID → Discord ID mapping
                        await ctx.syncedIds.register({
                          discordId: nonce,
                          roomyId: messageIdStr,
                        });
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
    },
  );
}
