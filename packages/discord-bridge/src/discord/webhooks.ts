import {
  DiscordBot,
  DiscordMessageOptions,
} from "./types.js";
import { discordWebhookTokensForBridge } from "../db.js";
import { GuildContext } from "../types.js";
import { tracer, recordError } from "../tracing.js";

/**
 * Get or create a webhook for a Discord channel.
 * Uses cached webhook tokens if available, otherwise reuses existing webhooks
 * or creates a new one.
 *
 * Discord limits: 15 webhooks per channel, 1000 per guild.
 * This function reuses existing "Roomy Bridge" webhooks to avoid hitting the limit.
 *
 * @param bot - Discord bot instance
 * @param guildId - Discord guild ID
 * @param spaceId - Roomy space ID
 * @param channelId - Discord channel ID to create webhook in
 * @returns Webhook {id, token} for executing messages
 * @throws Error if bot lacks MANAGE_WEBHOOKS permission or channel not found
 */
export async function getOrCreateWebhook(
  bot: DiscordBot,
  guildId: bigint,
  spaceId: string,
  channelId: bigint,
): Promise<{ id: string; token: string }> {
  const webhookTokens = discordWebhookTokensForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });

  // Step 1: Check cache first
  const cached = await webhookTokens.get(channelId.toString());
  if (cached) {
    const parts = cached.split(":");
    const id = parts[0];
    const token = parts[1];
    if (id && token) {
      return { id, token };
    }
  }

  // Step 2: Cache miss - fetch existing webhooks from Discord
  // This handles the case where the cache was cleared but webhooks still exist
  try {
    const existingWebhooks = await bot.rest.getChannelWebhooks(channelId);

    // Look for an existing "Roomy Bridge" webhook to reuse
    const roomyWebhook = existingWebhooks.find(
      (w) => w.name === "Roomy Bridge" && w.token
    );

    if (roomyWebhook && roomyWebhook.token) {
      console.log(
        `[Webhook] Reusing existing Roomy Bridge webhook ${roomyWebhook.id} in channel ${channelId}`
      );
      // Cache the existing webhook for future use
      await webhookTokens.put(
        channelId.toString(),
        `${roomyWebhook.id}:${roomyWebhook.token}`,
      );
      return { id: roomyWebhook.id, token: roomyWebhook.token };
    }

    // Step 3: No suitable webhook found - clean up old Roomy webhooks and create new one
    // If we have other Roomy Bridge webhooks without tokens (corrupted), delete them
    const corruptedWebhooks = existingWebhooks.filter(
      (w) => w.name === "Roomy Bridge" && !w.token
    );
    for (const corrupted of corruptedWebhooks) {
      try {
        await bot.helpers.deleteWebhook(BigInt(corrupted.id));
        console.log(
          `[Webhook] Deleted corrupted Roomy Bridge webhook ${corrupted.id}`
        );
      } catch (e) {
        // Ignore deletion errors
      }
    }

    // Check if we're at the 15 webhook limit
    if (existingWebhooks.length >= 15) {
      // Try to clean up the oldest non-Roomy webhook
      const nonRoomyWebhooks = existingWebhooks.filter((w) => w.name !== "Roomy Bridge");
      if (nonRoomyWebhooks.length > 0) {
        try {
          await bot.helpers.deleteWebhook(BigInt(nonRoomyWebhooks[0]!.id));
          console.log(
            `[Webhook] Deleted oldest non-Roomy webhook ${nonRoomyWebhooks[0]!.id} to make room`
          );
        } catch (e) {
          console.warn(
            `[Webhook] Failed to delete webhook to make room:`,
            e
          );
        }
      }
    }
  } catch (error) {
    // If fetching webhooks fails (e.g., permission error), log and continue to create
    console.warn(
      `[Webhook] Failed to fetch existing webhooks for channel ${channelId}:`,
      error
    );
  }

  // Step 4: Create new webhook
  const webhook = await bot.helpers.createWebhook(channelId, {
    name: "Roomy Bridge",
  });

  // Discord API should return the token when creating via bot
  if (!webhook.token) {
    throw new Error(
      "Webhook token not returned from Discord API - bot may lack MANAGE_WEBHOOKS permission. Consider setting TEST_WEBHOOK_ID and TEST_WEBHOOK_TOKEN environment variables for integration tests.",
    );
  }

  console.log(
    `[Webhook] Created new Roomy Bridge webhook ${webhook.id} in channel ${channelId}`
  );

  // Cache webhook token for future use
  await webhookTokens.put(
    channelId.toString(),
    `${webhook.id}:${webhook.token}`,
  );

  return { id: webhook.id.toString(), token: webhook.token };
}

/**
 * Execute a webhook with retry logic for rate limits and errors.
 *
 * Handles:
 * - 429 (Rate Limited): Wait Retry-After ms and retry
 * - 404 (Not Found): Clear cache and throw (caller should recreate webhook)
 * - 5xx (Server Errors): Retry with exponential backoff
 * - Network errors: Retry with exponential backoff
 *
 * @param bot - Discord bot instance
 * @param webhookId - Webhook ID to execute
 * @param webhookToken - Webhook token for authentication
 * @param options - Message options to send
 * @param retries - Current retry count (internal)
 * @returns Discord Message object if successful, null if failed after retries
 */
export async function executeWebhookWithRetry(
  bot: DiscordBot,
  webhookId: string,
  webhookToken: string,
  options: DiscordMessageOptions,
  retries = 0,
): ReturnType<typeof bot.helpers.executeWebhook> {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 1000; // 1 second

  try {
    return await bot.helpers.executeWebhook(
      BigInt(webhookId),
      webhookToken,
      options,
    );
  } catch (error: any) {
    await tracer.startActiveSpan("discord.webhook.execute", async (s) => {
      s.setAttribute("webhook.id", webhookId);
      s.setAttribute("error", error.message || String(error));
    });

    // Rate limited (429)
    if (error?.metadata?.code === 429 || error?.code === 429) {
      const retryAfter = error?.metadata?.retryAfter || error?.retryAfter || 1;
      const delayMs = retryAfter * 1000;
      console.warn(
        `Webhook rate limited, waiting ${retryAfter}s before retry`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return executeWebhookWithRetry(bot, webhookId, webhookToken, options, retries);
    }

    // Webhook deleted (404)
    if (error?.metadata?.code === 404 || error?.code === 404) {
      console.error(`Webhook ${webhookId} not found (404), clearing cache`);
      throw error; // Caller should clear cache and recreate
    }

    // Server errors or network issues - retry with exponential backoff
    if (
      error?.metadata?.code >= 500 ||
      error?.code >= 500 ||
      error?.code === "ECONNRESET" ||
      error?.code === "ETIMEDOUT"
    ) {
      if (retries < MAX_RETRIES) {
        const delayMs = BASE_DELAY * Math.pow(2, retries);
        console.warn(
          `Webhook execute failed (${error.message || error}), retrying in ${delayMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return executeWebhookWithRetry(
          bot,
          webhookId,
          webhookToken,
          options,
          retries + 1,
        );
      }
    }

    console.error(`Webhook execute failed after ${retries} retries:`, error);
    throw error;
  }
}

/**
 * Clear cached webhook token for a channel.
 * Use when webhooks are deleted externally (404 errors).
 *
 * @param guildId - Discord guild ID
 * @param spaceId - Roomy space ID
 * @param channelId - Channel ID to clear webhook cache for
 */
export async function clearWebhookCache(
  guildId: bigint,
  spaceId: string,
  channelId: bigint,
): Promise<void> {
  const webhookTokens = discordWebhookTokensForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  await webhookTokens.del(channelId.toString());
}
