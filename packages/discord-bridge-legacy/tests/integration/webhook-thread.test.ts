/**
 * Integration test: Webhook execution in threads.
 *
 * Reproduces the bug where sending a webhook message to a thread fails with
 * 400 "Invalid Form Body" because discordeno leaks query-only params (wait,
 * thread_id) into the JSON body.
 *
 * Required environment variables:
 * - DISCORD_TOKEN: Discord bot token
 * - TEST_GUILD_ID: Discord guild ID for testing
 * - TEST_CHANNEL_ID: Discord channel ID for testing
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createBot, GatewayIntents } from "@discordeno/bot";
import type { DiscordBot } from "../../src/discord/types.js";
import { desiredProperties } from "../../src/discord/types.js";
import {
  getOrCreateWebhook,
  executeWebhookWithRetry,
} from "../../src/discord/webhooks.js";
import { MockBridgeRepository } from "../../src/repositories/MockBridgeRepository.js";

let bot: DiscordBot;
let testGuildId: bigint;
let testChannelId: bigint;
let createdThreadId: bigint | undefined;

beforeAll(async () => {
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.TEST_GUILD_ID;
  const channelId = process.env.TEST_CHANNEL_ID;

  if (!token || !guildId || !channelId) {
    throw new Error(
      "Missing required environment variables: DISCORD_TOKEN, TEST_GUILD_ID, TEST_CHANNEL_ID",
    );
  }

  testGuildId = BigInt(guildId);
  testChannelId = BigInt(channelId);

  bot = createBot({
    token,
    desiredProperties,
    gateway: {
      intents: GatewayIntents.Guilds | GatewayIntents.GuildMessages,
    },
  }) as DiscordBot;

  console.log("Discord bot connected");
}, 30000);

afterAll(async () => {
  // Clean up the thread we created
  if (createdThreadId) {
    try {
      await bot.helpers.deleteChannel(createdThreadId);
      console.log("Cleaned up test thread:", createdThreadId.toString());
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("Webhook execution in threads", () => {
  it("sends a webhook message to a channel (baseline)", async () => {
    const repo = new MockBridgeRepository();
    const webhook = await getOrCreateWebhook(
      bot,
      testGuildId,
      "did:web:test" as any,
      testChannelId,
      repo,
    );

    const result = await executeWebhookWithRetry(
      bot,
      webhook.id,
      webhook.token,
      { content: `webhook-channel-test-${Date.now()}`, username: "Test Bot" },
    );

    expect(result?.id).toBeTruthy();
    console.log("Channel webhook message sent:", result?.id?.toString());
  });

  it("sends a webhook message to a thread via threadId", async () => {
    // Step 1: Create a starter message in the channel
    const starterMsg = await bot.helpers.sendMessage(testChannelId, {
      content: `thread-webhook-test-starter-${Date.now()}`,
    });
    expect(starterMsg.id).toBeTruthy();

    // Step 2: Create a thread from the starter message
    const thread = await bot.helpers.startThreadWithMessage(
      testChannelId,
      starterMsg.id,
      { name: `webhook-test-${Date.now()}`, autoArchiveDuration: 60 },
    );
    createdThreadId = thread.id;
    expect(thread.id).toBeTruthy();
    console.log("Created test thread:", thread.id.toString());

    // Step 3: Get webhook for the PARENT channel (not the thread)
    const repo = new MockBridgeRepository();
    const webhook = await getOrCreateWebhook(
      bot,
      testGuildId,
      "did:web:test" as any,
      testChannelId, // parent channel
      repo,
    );

    // Step 4: Execute webhook with threadId — this is the operation that fails
    const result = await executeWebhookWithRetry(
      bot,
      webhook.id,
      webhook.token,
      {
        content: `webhook-in-thread-test-${Date.now()}`,
        username: "Thread Test Bot",
        threadId: thread.id,
      },
    );

    expect(result?.id).toBeTruthy();
    console.log(
      "Thread webhook message sent:",
      result?.id?.toString(),
      "in thread:",
      thread.id.toString(),
    );
  });
});
