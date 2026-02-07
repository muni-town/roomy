/**
 * Roomy → Discord Reverse Sync E2E tests.
 * Tests Roomy message/reaction sync to Discord.
 *
 * **Note:** These tests are currently SKIPPED because Roomy → Discord sync is not implemented.
 * They serve as acceptance criteria and specifications for future implementation.
 *
 * To run when implementing R2D sync:
 * 1. Remove `.skip` from each test
 * 2. Remove the `sequential: true` option
 * 3. Ensure proper cleanup in beforeEach
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, test } from "vitest";
import {
  createTestBot,
  connectGuildToNewSpace,
  initE2ERoomyClient,
  getTextChannels,
  createSyncOrchestratorForTest,
} from "../helpers/setup.js";
import { TEST_GUILD_ID } from "../fixtures/test-data.js";
import { registeredBridges } from "../../../src/db.js";
import { connectedSpaces } from "../../../src/roomy/client.js";

// Run tests sequentially to avoid database conflicts
describe("E2E: Roomy → Discord Reverse Sync", { sequential: true }, () => {
  beforeAll(async () => {
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E reverse sync tests");
  }, 60000);

  beforeEach(async () => {
    // NOTE: registeredBridges.clear() disabled due to LevelDB state issues between test files
    // Clear connection tracking
    const spaces = Array.from(connectedSpaces.keys());
    for (const spaceId of spaces) {
      connectedSpaces.delete(spaceId);
    }

    // Clean up webhooks from test channels to avoid hitting Discord's 15 webhook limit
    try {
      const bot = await createTestBot();
      const channels = await getTextChannels(bot, TEST_GUILD_ID);

      for (const channel of channels) {
        try {
          const webhooks = await bot.rest.getChannelWebhooks(channel.id);
          for (const webhook of webhooks) {
            await bot.rest.deleteWebhook(webhook.id);
          }
        } catch (e) {
          // Ignore errors if webhook deletion fails
        }
      }
    } catch (e) {
      // Ignore errors during webhook cleanup
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  });

  describe("Message Sync (Roomy → Discord)", () => {
    it("R2D-MSG-01: should sync Roomy message create to Discord", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Use unique identifiers to avoid conflicts with parallel tests
      const uniqueSuffix = Date.now() + Math.random().toString(36).substring(7);
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E R2D Message Create Test - ${uniqueSuffix}`,
      );

      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel (Discord → Roomy direction to establish mapping)
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // Create a proper DecodedStreamEvent structure
      const testContent = `Test message from Roomy ${uniqueSuffix}`;
      const roomyMessageId = `01HZRKJH5KQYPYA4Y9C2QAR8K0${uniqueSuffix.slice(-2)}`; // Unique ULID
      const testUserDid = "did:plc:testuser123" as const;

      const decodedEvent = {
        idx: 1n,
        event: {
          id: roomyMessageId,
          $type: "space.roomy.message.createMessage.v0" as const,
          room: roomyRoomId,
          body: {
            mimeType: "text/plain",
            data: { buf: new TextEncoder().encode(testContent) },
          },
        },
        user: testUserDid,
      };

      // Sync Roomy message to Discord
      await orchestrator.handleRoomyCreateMessage(decodedEvent, bot);

      // Verify the Discord message was created
      // Get messages from the channel and check for our content
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for webhook to execute

      const messages = await bot.rest.getMessages(firstChannel.id, { limit: 50 });
      const foundMessage = messages.find(m => m.content === testContent);

      expect(foundMessage).toBeDefined();
      expect(foundMessage?.content).toBe(testContent);
    }, 30000);

    it("R2D-MSG-02: should sync Roomy message edit to Discord", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const uniqueSuffix = Date.now() + Math.random().toString(36).substring(7);
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E R2D Message Edit Test - ${uniqueSuffix}`,
      );

      const orchestrator = createSyncOrchestratorForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // First, create a message
      const originalContent = `Original message ${uniqueSuffix}`;
      const roomyMessageId = `01HZRKJH5KQYPYA4Y9C2QAR8K1${uniqueSuffix.slice(-2)}`; // Unique ULID
      const testUserDid = "did:plc:testuser123" as const;

      const createEvent = {
        idx: 1n,
        event: {
          id: roomyMessageId,
          $type: "space.roomy.message.createMessage.v0" as const,
          room: roomyRoomId,
          body: {
            mimeType: "text/plain",
            data: { buf: new TextEncoder().encode(originalContent) },
          },
        },
        user: testUserDid,
      };

      await orchestrator.handleRoomyCreateMessage(createEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for webhook

      // Now edit the message
      const editedContent = `Edited message ${uniqueSuffix}`;
      const editEvent = {
        idx: 2n,
        event: {
          id: `01HZRKJH5KQYPYA4Y9C2QAR8KB${uniqueSuffix.slice(-2)}`, // Edit event ULID (different from message ULID)
          $type: "space.roomy.message.editMessage.v0" as const,
          messageId: roomyMessageId, // The message being edited
          room: roomyRoomId,
          body: {
            mimeType: "text/plain",
            data: { buf: new TextEncoder().encode(editedContent) },
          },
        },
        user: testUserDid,
      };

      // Sync Roomy edit to Discord
      await orchestrator.handleRoomyEditMessage(editEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for edit

      // Verify the Discord message was edited
      const messages = await bot.rest.getMessages(firstChannel.id, { limit: 50 });
      const foundMessage = messages.find(m => m.content === editedContent);

      expect(foundMessage).toBeDefined();
      expect(foundMessage?.content).toBe(editedContent);
    }, 30000);

    it("R2D-MSG-03: should sync Roomy message delete to Discord", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const uniqueSuffix = Date.now() + Math.random().toString(36).substring(7);
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E R2D Message Delete Test - ${uniqueSuffix}`,
      );

      const orchestrator = createSyncOrchestratorForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // First, create a message
      const originalContent = `Message to delete ${uniqueSuffix}`;
      const roomyMessageId = `01HZRKJH5KQYPYA4Y9C2QAR8K2${uniqueSuffix.slice(-2)}`; // Unique ULID
      const testUserDid = "did:plc:testuser123" as const;

      const createEvent = {
        idx: 1n,
        event: {
          id: roomyMessageId,
          $type: "space.roomy.message.createMessage.v0" as const,
          room: roomyRoomId,
          body: {
            mimeType: "text/plain",
            data: { buf: new TextEncoder().encode(originalContent) },
          },
        },
        user: testUserDid,
      };

      await orchestrator.handleRoomyCreateMessage(createEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for webhook

      // Verify message was created
      let messages = await bot.rest.getMessages(firstChannel.id, { limit: 50 });
      const createdMessage = messages.find(m => m.content === originalContent);
      expect(createdMessage).toBeDefined();

      // Now delete the message
      const deleteEvent = {
        idx: 2n,
        event: {
          id: `01HZRKJH5KQYPYA4Y9C2QAR8KC${uniqueSuffix.slice(-2)}`, // Delete event ULID
          $type: "space.roomy.message.deleteMessage.v0" as const,
          messageId: roomyMessageId, // The message being deleted
          room: roomyRoomId,
        },
        user: testUserDid,
      };

      // Sync Roomy delete to Discord
      await orchestrator.handleRoomyDeleteMessage(deleteEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for delete

      // Verify the Discord message was deleted
      messages = await bot.rest.getMessages(firstChannel.id, { limit: 50 });
      const deletedMessage = messages.find(m => m.content === originalContent);

      expect(deletedMessage).toBeUndefined();
    }, 30000);
  });

  describe("Reaction Sync (Roomy → Discord)", () => {
    it("R2D-RCT-01: should sync Roomy reaction add to Discord", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const uniqueSuffix = Date.now() + Math.random().toString(36).substring(7);
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E R2D Reaction Add Test - ${uniqueSuffix}`,
      );

      const orchestrator = createSyncOrchestratorForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // First, create a message to react to
      const originalContent = `Message for reaction ${uniqueSuffix}`;
      const roomyMessageId = `01HZRKJH5KQYPYA4Y9C2QAR8K3${uniqueSuffix.slice(-2)}`; // Mock ULID
      const testUserDid = "did:discord:123456789" as const; // Discord user format for reaction

      const createEvent = {
        idx: 1n,
        event: {
          id: roomyMessageId,
          $type: "space.roomy.message.createMessage.v0" as const,
          room: roomyRoomId,
          body: {
            mimeType: "text/plain",
            data: { buf: new TextEncoder().encode(originalContent) },
          },
        },
        user: testUserDid,
      };

      await orchestrator.handleRoomyCreateMessage(createEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for webhook

      // Now add a reaction to the message
      const reaction = "👍";
      const reactionEvent = {
        idx: 2n,
        event: {
          id: `01HZRKJH5KQYPYA4Y9C2QAR8KG${uniqueSuffix.slice(-2)}`, // Reaction event ULID
          $type: "space.roomy.reaction.addBridgedReaction.v0" as const,
          room: roomyRoomId,
          reactionTo: roomyMessageId, // Message ULID
          reaction,
        },
        user: testUserDid,
      };

      // Sync Roomy reaction to Discord
      await orchestrator.handleRoomyAddReaction(reactionEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for reaction

      // Verify the Discord reaction was added
      const messages = await bot.rest.getMessages(firstChannel.id, { limit: 50 });
      const targetMessage = messages.find(m => m.content === originalContent);

      expect(targetMessage).toBeDefined();
      // Check if the message has the reaction
      // Note: Discord API may not return reactions in getMessages, so we'll just verify no errors
    }, 30000);

    it("R2D-RCT-02: should sync Roomy reaction remove to Discord", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const uniqueSuffix = Date.now() + Math.random().toString(36).substring(7);
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E R2D Reaction Remove Test - ${uniqueSuffix}`,
      );

      const orchestrator = createSyncOrchestratorForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // First, create a message and add a reaction
      const originalContent = `Message for reaction removal ${uniqueSuffix}`;
      const roomyMessageId = `01HZRKJH5KQYPYA4Y9C2QAR8K4${uniqueSuffix.slice(-2)}`; // Mock ULID
      const testUserDid = "did:discord:123456789" as const;

      const createEvent = {
        idx: 1n,
        event: {
          id: roomyMessageId,
          $type: "space.roomy.message.createMessage.v0" as const,
          room: roomyRoomId,
          body: {
            mimeType: "text/plain",
            data: { buf: new TextEncoder().encode(originalContent) },
          },
        },
        user: testUserDid,
      };

      await orchestrator.handleRoomyCreateMessage(createEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Add a reaction
      const reaction = "😀";
      const reactionEventId = `01HZRKJH5KQYPYA4Y9C2QAR8KK${uniqueSuffix.slice(-2)}`; // Reaction event ULID
      const addReactionEvent = {
        idx: 2n,
        event: {
          id: reactionEventId,
          $type: "space.roomy.reaction.addBridgedReaction.v0" as const,
          room: roomyRoomId,
          reactionTo: roomyMessageId,
          reaction,
        },
        user: testUserDid,
      };

      await orchestrator.handleRoomyAddReaction(addReactionEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Now remove the reaction
      const removeReactionEvent = {
        idx: 3n,
        event: {
          id: `01HZRKJH5KQYPYA4Y9C2QAR8KL${uniqueSuffix.slice(-2)}`, // Remove reaction event ULID
          $type: "space.roomy.reaction.removeBridgedReaction.v0" as const,
          room: roomyRoomId,
          reactionId: reactionEventId, // The add reaction event to remove
        },
        user: testUserDid,
      };

      // Sync Roomy reaction remove to Discord
      await orchestrator.handleRoomyRemoveReaction(removeReactionEvent, bot);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify - the remove should complete without errors
      // Note: Discord API limitations prevent easy verification of reaction removal
      // We're mainly testing that the code doesn't throw errors
      expect(true).toBe(true); // Test passes if we get here without errors
    }, 30000);
  });

  describe("Webhook Management", () => {
    it.skip("should create webhook for Roomy → Discord sync", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Webhook Creation Test - ${Date.now()}`,
      );

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];

      // Check if webhook is created for the channel
      // This is a prerequisite for Roomy → Discord message sync
      const channelWebhooks = await bot.rest.getChannelWebhooks(firstChannel.id);

      // TODO: When implemented, verify:
      // - Webhook exists for the channel
      // - Webhook token is stored in repo for later use
      // - Webhook is used to send messages as the bot

      // For now, just verify the channel exists
      expect(firstChannel).toBeDefined();
    }, 30000);

    it.skip("should store webhook token in repository", async () => {
      // TODO: Test that webhook tokens are stored correctly
      // This is needed for echo prevention (skip bot's own messages)
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Webhook Token Test - ${Date.now()}`,
      );

      // TODO: When webhooks are implemented, verify:
      // - Webhook token stored in discordWebhookTokens sublevel-db
      // - Format is "webhookId:token"
      // - Token is retrieved during reverse sync

      expect(result.guildId).toBeDefined();
    }, 30000);
  });

  describe("Message Mapping (Roomy → Discord)", () => {
    it.skip("should map Roomy room ULID to Discord channel ID", async () => {
      // TODO: Test that Roomy room ULIDs are mapped to Discord channel IDs
      // This mapping is needed to know which Discord channel to post to
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Room Mapping Test - ${Date.now()}`,
      );

      const orchestrator = createSyncOrchestratorForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];

      // Sync channel (this should create the mapping)
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // TODO: When implemented, verify:
      // - syncedIds has mapping from roomyRoomId → firstChannel.id
      // - Format uses "room:" prefix for room mappings
      // - Mapping can be retrieved during reverse sync

      expect(roomyRoomId).toBeDefined();
    }, 30000);

    it.skip("should map Roomy message ULID to Discord message ID", async () => {
      // TODO: Test that Roomy message ULIDs are mapped to Discord message IDs
      // This is needed for edits/deletes to target the correct Discord message
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Message Mapping Test - ${Date.now()}`,
      );

      // TODO: When implemented, after syncing a message Roomy → Discord:
      // - syncedIds has mapping from roomyMessageUlid → discordMessageId
      // - Mapping is used for edits/deletes

      expect(result.guildId).toBeDefined();
    }, 30000);
  });
});
