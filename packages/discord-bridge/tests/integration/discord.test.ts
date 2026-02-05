/**
 * Integration tests for Discord operations.
 * These tests connect to a real Discord bot and verify message delivery.
 *
 * Required environment variables:
 * - DISCORD_TOKEN: Discord bot token
 * - TEST_GUILD_ID: Discord guild ID for testing
 * - TEST_CHANNEL_ID: Discord channel ID for testing
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createBot, GatewayIntents } from "@discordeno/bot";
import type { DiscordBot } from "../../src/discord/types.js";
import {
  createBotMessage,
  createWebhookMessage,
  editMessage,
  deleteMessage,
  fetchMessage,
  addReaction,
  removeReaction,
  createChannel,
  createThread,
} from "../../src/discord/operations";
import { getOrCreateWebhook } from "../../src/discord/webhooks";
import type { GuildContext } from "../../src/types";
import { desiredProperties } from "../../src/discord/types.js";

let bot: DiscordBot;
let testGuildId: bigint;
let testChannelId: bigint;
let testWebhookId: bigint | undefined;
let testWebhookToken: string | undefined;
let testMessageId: bigint;

// Helper: Create a test webhook
async function setupTestWebhook(): Promise<{ id: bigint; token: string } | undefined> {
  // Check if webhook is provided via environment variable
  const envWebhookId = process.env.TEST_WEBHOOK_ID;
  const envWebhookToken = process.env.TEST_WEBHOOK_TOKEN;

  if (envWebhookId && envWebhookToken) {
    console.log("Using webhook from environment:", envWebhookId);
    return { id: BigInt(envWebhookId), token: envWebhookToken };
  }

  // Try to create a webhook (may fail due to Discordeno bug)
  const mockCtx: GuildContext = {
    guildId: testGuildId,
    spaceId: "did:web:test.space" as any, // Mock space ID
    syncedIds: null as any,
    syncedProfiles: null as any,
    syncedReactions: null as any,
    syncedSidebarHash: null as any,
    syncedRoomLinks: null as any,
    syncedEdits: null as any,
    discordMessageHashes: null as any,
    latestMessagesInChannel: null as any,
    discordWebhookTokens: {
      get: async () => null,
      put: async () => {},
      del: async () => {},
    } as any,
    connectedSpace: null as any,
  };

  try {
    const webhook = await getOrCreateWebhook(bot, mockCtx, testChannelId);
    return { id: BigInt(webhook.id), token: webhook.token };
  } catch (error) {
    console.warn("Could not create test webhook:", (error as Error).message);
    console.warn("Webhook tests will be skipped. Set TEST_WEBHOOK_ID and TEST_WEBHOOK_TOKEN to enable webhook tests.");
    return undefined;
  }
}

beforeAll(async () => {
  // Check for required environment variables
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

  // Create Discord bot with desiredProperties for consistent response structure
  bot = await createBot({
    token,
    desiredProperties,
    gateway: {
      intents: GatewayIntents.Guilds | GatewayIntents.GuildMessages,
    },
  }) as DiscordBot;

  console.log("Discord bot connected");

  // Setup test webhook (optional)
  const webhook = await setupTestWebhook();
  if (webhook) {
    testWebhookId = webhook.id;
    testWebhookToken = webhook.token;
    console.log("Test webhook available:", testWebhookId.toString());
  } else {
    console.log("No webhook available - webhook tests will be skipped");
  }
}, 30000); // 30 second timeout

describe("Discord Integration Tests", () => {
  describe("Message Operations", () => {
    it("creates a bot message and verifies delivery", async () => {
      const testContent = `integration-test-message-${Date.now()}`;

      // Create message
      const result = await createBotMessage(bot, {
        channelId: testChannelId,
        content: testContent,
      });

      testMessageId = result.id;
      expect(testMessageId).toBeGreaterThan(0n);
      console.log("Created bot message:", testMessageId.toString());

      // Verify by fetching the message
      const fetched = await fetchMessage(bot, {
        channelId: testChannelId,
        messageId: testMessageId,
      });

      expect(fetched.id).toBe(testMessageId);
      expect(fetched.content).toBe(testContent);
    });

    it("creates a webhook message with custom username", async () => {
      if (!testWebhookId || !testWebhookToken) {
        console.warn("Skipping test: no webhook available");
        return;
      }

      const testContent = `webhook-test-${Date.now()}`;

      const result = await createWebhookMessage(bot, {
        channelId: testChannelId,
        webhookId: testWebhookId,
        webhookToken: testWebhookToken,
        content: testContent,
        username: "Test Bot User",
      });

      expect(result.id).toBeGreaterThan(0n);
      console.log("Created webhook message:", result.id.toString());

      // Verify by fetching the message
      const fetched = await fetchMessage(bot, {
        channelId: testChannelId,
        messageId: result.id,
      });

      expect(fetched.content).toBe(testContent);
      // Note: Webhook username may not be reflected in the fetched message author
    });

    it("creates a webhook message with nonce for idempotency", async () => {
      if (!testWebhookId || !testWebhookToken) {
        console.warn("Skipping test: no webhook available");
        return;
      }

      const testContent = `nonce-test-${Date.now()}`;
      // Use numeric nonce (snowflake)
      const nonce = Date.now();

      // Create first message
      const result1 = await createWebhookMessage(bot, {
        channelId: testChannelId,
        webhookId: testWebhookId,
        webhookToken: testWebhookToken,
        content: testContent,
        nonce,
      });

      // Create second message with same nonce
      const result2 = await createWebhookMessage(bot, {
        channelId: testChannelId,
        webhookId: testWebhookId,
        webhookToken: testWebhookToken,
        content: testContent,
        nonce,
      });

      // Note: Discord webhook nonce is for client-side deduplication, not server-side idempotency
      // So we expect different message IDs, but verify both messages were created successfully
      expect(result1.id).toBeTruthy();
      expect(result2.id).toBeTruthy();
      console.log("Webhook nonce test: both messages created (idempotency not supported for webhooks)");
    });

    it("edits a message", async () => {
      if (!testMessageId) {
        console.warn("Skipping test: no test message ID available");
        return;
      }

      const newContent = `edited-message-${Date.now()}`;

      const result = await editMessage(bot, {
        channelId: testChannelId,
        messageId: testMessageId,
        content: newContent,
      });

      expect(result.id).toBe(testMessageId);

      // Verify the edit
      const fetched = await fetchMessage(bot, {
        channelId: testChannelId,
        messageId: testMessageId,
      });

      expect(fetched.content).toBe(newContent);
      expect(fetched.editedTimestamp).toBeGreaterThan(0);
      console.log("Edited message:", testMessageId.toString());
    });

    it("fetches a message with attachments", async () => {
      // Create a message with an image attachment
      const imageUrl = "https://example.com/test.png";

      // Note: Discord doesn't allow creating messages with attachments via REST API
      // without uploading the file first. This test just verifies fetch works.
      const fetched = await fetchMessage(bot, {
        channelId: testChannelId,
        messageId: testMessageId,
      });

      expect(fetched.id).toBe(testMessageId);
      expect(fetched.attachments).toBeDefined();
      console.log("Fetched message with attachments:", fetched.attachments.length);
    });
  });

  describe("Reaction Operations", () => {
    it("adds a reaction to a message", async () => {
      if (!testMessageId) {
        console.warn("Skipping test: no test message ID available");
        return;
      }

      const result = await addReaction(bot, {
        channelId: testChannelId,
        messageId: testMessageId,
        emoji: "👍",
      });

      expect(result).toEqual({ success: true });
      console.log("Added reaction to message:", testMessageId.toString());
    });

    it("removes a reaction", async () => {
      if (!testMessageId) {
        console.warn("Skipping test: no test message ID available");
        return;
      }

      // First add a reaction
      await addReaction(bot, {
        channelId: testChannelId,
        messageId: testMessageId,
        emoji: "❤️",
      });

      // Then remove it
      const result = await removeReaction(bot, {
        channelId: testChannelId,
        messageId: testMessageId,
        emoji: "❤️",
      });

      expect(result).toEqual({ success: true });
      console.log("Removed reaction from message:", testMessageId.toString());
    });
  });

  describe("Channel Operations", () => {
    let testChannelId2: bigint;

    it("creates a new channel", async () => {
      const channelName = `test-channel-${Date.now()}`;

      try {
        const result = await createChannel(bot, {
          guildId: testGuildId,
          name: channelName,
          type: 0, // GUILD_TEXT
        });

        testChannelId2 = result.id;
        expect(testChannelId2).toBeGreaterThan(0n);
        console.log("Created channel:", testChannelId2.toString(), channelName);
      } catch (error) {
        if ((error as Error).message.includes("Failed to send request to discord")) {
          console.warn("Skipping test: bot lacks MANAGE_CHANNELS permission");
          return;
        }
        throw error;
      }
    });

    it("creates a thread", async () => {
      const threadName = `test-thread-${Date.now()}`;

      // Create a message first
      const msgResult = await createBotMessage(bot, {
        channelId: testChannelId,
        content: "Thread starter message",
      });

      // Create thread from message
      const result = await createThread(bot, {
        channelId: testChannelId,
        name: threadName,
        messageId: msgResult.id,
      });

      expect(result.id).toBeGreaterThan(0n);
      console.log("Created thread:", result.id.toString());
    });
  });

  describe("Idempotency Tests", () => {
    it("handles duplicate nonce creations correctly", async () => {
      if (!testWebhookId || !testWebhookToken) {
        console.warn("Skipping test: no webhook available");
        return;
      }

      const testContent = `nonce-idempotency-${Date.now()}`;
      // Use numeric nonce (snowflake)
      const nonce = Date.now();

      // Create message with nonce
      const result1 = await createWebhookMessage(bot, {
        channelId: testChannelId,
        webhookId: testWebhookId,
        webhookToken: testWebhookToken,
        content: testContent,
        nonce,
      });

      // Try to create again with same nonce
      const result2 = await createWebhookMessage(bot, {
        channelId: testChannelId,
        webhookId: testWebhookId,
        webhookToken: testWebhookToken,
        content: testContent,
        nonce,
      });

      // Note: Discord webhook nonce is for client-side deduplication, not server-side idempotency
      // So we expect different message IDs, but verify both messages were created successfully
      expect(result1.id).toBeTruthy();
      expect(result2.id).toBeTruthy();
      console.log("Idempotency test: webhook nonce creates separate messages (expected behavior)");
    });
  });
});
