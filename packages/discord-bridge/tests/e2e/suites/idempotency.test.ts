/**
 * Idempotency E2E tests.
 * Tests that duplicate and out-of-order events are handled correctly.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
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

describe("E2E: Discord Bridge Idempotency", () => {
  beforeAll(async () => {
    // Initialize Roomy client once
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E idempotency tests");
  }, 60000);

  beforeEach(async () => {
    // NOTE: Database cleanup disabled due to LevelDB state issues between test files
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  afterEach(async () => {
    // afterEach cleanup is now handled by beforeEach in the next test
  });

  describe("Duplicate Event Delivery (IDM-08)", () => {
    it("IDM-08: should handle duplicate event delivery (gateway replay)", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Duplicate Event Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // Create a test message in Discord
      const testContent = `Test message at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      // Sync the message to Roomy (first time)
      const roomyMessageId1 = await orchestrator.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );

      expect(roomyMessageId1).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 500));

      // Sync the SAME message again (simulating gateway replay/duplicate delivery)
      const roomyMessageId2 = await orchestrator.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );

      // Verify: Same room ID returned (idempotent)
      expect(roomyMessageId1).toBe(roomyMessageId2);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify: Only ONE createMessage event exists (not duplicated)
      const events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      const createMessageEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.createMessage.v0"
      );

      const eventsForThisMessage = createMessageEvents.filter(
        (e: any) => e.id === roomyMessageId1
      );

      expect(eventsForThisMessage.length).toBe(1);

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);

    it("IDM-08: should handle duplicate edit event delivery", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Duplicate Edit Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // Create and sync a message
      const originalContent = `Original message at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: originalContent,
      });

      await orchestrator.handleDiscordMessageCreate(testMessage, roomyRoomId);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Edit the message
      const editedContent = `Edited message at ${Date.now()}`;
      const editedMessage = await bot.helpers.editMessage(firstChannel.id, testMessage.id, {
        content: editedContent,
      });

      // Sync the edit (first time)
      await orchestrator.handleDiscordMessageUpdate(editedMessage);
      await new Promise(resolve => setTimeout(resolve, 500));

      let events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      let editEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.editMessage.v0"
      );

      const firstEditCount = editEvents.length;

      // Sync the SAME edit again (simulating gateway replay)
      await orchestrator.handleDiscordMessageUpdate(editedMessage);
      await new Promise(resolve => setTimeout(resolve, 500));

      events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      editEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.editMessage.v0"
      );

      // Verify: No new edit event created (idempotent)
      expect(editEvents.length).toBe(firstEditCount);

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  describe("Out-of-Order Event Handling (IDM-09)", () => {
    it("IDM-09: should handle out-of-order edit events (timestamp ordering)", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Out of Order Edit Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // Create and sync a message
      const originalContent = `Original message at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: originalContent,
      });

      await orchestrator.handleDiscordMessageCreate(testMessage, roomyRoomId);
      await new Promise(resolve => setTimeout(resolve, 500));

      // First edit
      const firstEditContent = `First edit at ${Date.now()}`;
      const firstEdit = await bot.helpers.editMessage(firstChannel.id, testMessage.id, {
        content: firstEditContent,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      // Second edit (newer)
      const secondEditContent = `Second edit at ${Date.now()}`;
      const secondEdit = await bot.helpers.editMessage(firstChannel.id, testMessage.id, {
        content: secondEditContent,
      });

      // Sync the SECOND edit first (newer edit arrives first)
      await orchestrator.handleDiscordMessageUpdate(secondEdit);
      await new Promise(resolve => setTimeout(resolve, 500));

      let events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      let editEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.editMessage.v0"
      );

      expect(editEvents.length).toBe(1);

      // Now sync the FIRST edit (older edit arrives later)
      await orchestrator.handleDiscordMessageUpdate(firstEdit);
      await new Promise(resolve => setTimeout(resolve, 500));

      events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      editEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.editMessage.v0"
      );

      // Verify: Older edit is skipped (still only 1 edit event)
      expect(editEvents.length).toBe(1);

      // Verify: The content is from the NEWER edit (not overwritten by older edit)
      const latestEdit = editEvents[0];
      const { fromBytes } = await import("@roomy/sdk");
      const editBodyData = fromBytes(latestEdit.body?.data);
      const decodedEdit = new TextDecoder().decode(editBodyData);
      expect(decodedEdit).toBe(secondEditContent);

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  describe("Partial Re-Sync (IDM-10)", () => {
    it("IDM-10: should handle partial re-sync (single channel)", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Partial Re-sync Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThanOrEqual(2);

      // Sync TWO channels
      const firstChannel = channels[0];
      const secondChannel = channels[1];
      const roomyRoomId1 = await orchestrator.handleDiscordChannelCreate(firstChannel);
      const roomyRoomId2 = await orchestrator.handleDiscordChannelCreate(secondChannel);

      expect(roomyRoomId1).toBeDefined();
      expect(roomyRoomId2).toBeDefined();

      // Create messages in both channels
      const message1 = await bot.helpers.sendMessage(firstChannel.id, {
        content: `Message in channel 1 at ${Date.now()}`,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      const message2 = await bot.helpers.sendMessage(secondChannel.id, {
        content: `Message in channel 2 at ${Date.now()}`,
      });

      // Sync only the FIRST channel (partial sync)
      const syncedId1 = await orchestrator.handleDiscordMessageCreate(message1, roomyRoomId1);

      expect(syncedId1).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify: First message was synced
      const events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      const createMessageEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.createMessage.v0"
      );

      // Should have only 1 message (from first channel)
      expect(createMessageEvents.length).toBe(1);

      // Now sync the SECOND channel
      const syncedId2 = await orchestrator.handleDiscordMessageCreate(message2, roomyRoomId2);

      expect(syncedId2).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify: Second message was synced
      const events2 = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      const createMessageEvents2 = events2.filter(
        (e: any) => e.$type === "space.roomy.message.createMessage.v0"
      );

      // Should now have 2 messages total
      expect(createMessageEvents2.length).toBe(2);

      // Clean up: Delete test messages
      await bot.helpers.deleteMessage(firstChannel.id, message1.id);
      await bot.helpers.deleteMessage(secondChannel.id, message2.id);
    }, 30000);

    it("IDM-10: should not affect other channels during partial re-sync", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Partial Re-sync Isolation Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThanOrEqual(2);

      // Sync two channels
      const firstChannel = channels[0];
      const secondChannel = channels[1];
      const roomyRoomId1 = await orchestrator.handleDiscordChannelCreate(firstChannel);
      const roomyRoomId2 = await orchestrator.handleDiscordChannelCreate(secondChannel);

      // Create and sync message in channel 1
      const message1 = await bot.helpers.sendMessage(firstChannel.id, {
        content: `Message 1 at ${Date.now()}`,
      });

      await orchestrator.handleDiscordMessageCreate(message1, roomyRoomId1);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Create and sync message in channel 2
      const message2 = await bot.helpers.sendMessage(secondChannel.id, {
        content: `Message 2 at ${Date.now()}`,
      });

      await orchestrator.handleDiscordMessageCreate(message2, roomyRoomId2);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Re-sync channel 1 message (should not affect channel 2)
      const resyncedId = await orchestrator.handleDiscordMessageCreate(message1, roomyRoomId1);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify: Both messages still exist
      const events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      const createMessageEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.createMessage.v0"
      );

      expect(createMessageEvents.length).toBe(2);

      // Verify: Re-sync returned same ID (idempotent)
      expect(resyncedId).toBeDefined();
      const message1Event = createMessageEvents.find((e: any) => e.id === resyncedId);
      expect(message1Event).toBeDefined();

      // Clean up: Delete test messages
      await bot.helpers.deleteMessage(firstChannel.id, message1.id);
      await bot.helpers.deleteMessage(secondChannel.id, message2.id);
    }, 30000);
  });
});
