import {
  DiscordBot,
  DiscordMessageOptions,
} from "./types.js";
import { discordWebhookTokensForBridge } from "../db.js";
import { GuildContext } from "../types.js";
import { tracer, recordError } from "../tracing.js";

/**
 * Get or create a webhook for a Discord channel.
 * Uses cached webhook tokens if available, otherwise creates a new webhook.
 *
 * @param bot - Discord bot instance
 * @param ctx - Guild context containing space/guild IDs
 * @param channelId - Discord channel ID to create webhook in
 * @returns Webhook {id, token} for executing messages
 * @throws Error if bot lacks MANAGE_WEBHOOKS permission or channel not found
 */
export async function getOrCreateWebhook(
  bot: DiscordBot,
  ctx: GuildContext,
  channelId: bigint,
): Promise<{ id: string; token: string }> {
  const webhookTokens = discordWebhookTokensForBridge({
    discordGuildId: ctx.guildId,
    roomySpaceId: ctx.spaceId,
  });
  const cached = await webhookTokens.get(channelId.toString());

  if (cached) {
    const parts = cached.split(":");
    const id = parts[0];
    const token = parts[1];
    if (id && token) {
      return { id, token };
    }
  }

  // Create new webhook
  const webhook = await bot.helpers.createWebhook(channelId, {
    name: "Roomy Bridge",
  });

  if (!webhook.token) {
    throw new Error("Webhook token not returned from Discord API");
  }

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
 * @param ctx - Guild context
 * @param channelId - Channel ID to clear webhook cache for
 */
export async function clearWebhookCache(
  ctx: GuildContext,
  channelId: bigint,
): Promise<void> {
  const webhookTokens = discordWebhookTokensForBridge({
    discordGuildId: ctx.guildId,
    roomySpaceId: ctx.spaceId,
  });
  await webhookTokens.del(channelId.toString());
}
