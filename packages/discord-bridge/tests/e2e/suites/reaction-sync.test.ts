/**
 * Reaction sync E2E tests.
 * Tests Discord -> Roomy reaction synchronization:
 * - Basic reaction add (unicode emoji)
 * - Custom emoji reaction add
 * - Reaction remove
 * - Idempotency
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

describe("E2E: Discord Reaction Sync (D→R)", () => {
  beforeAll(async () => {
    // Initialize Roomy client once
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E reaction sync tests");
  }, 60000);

  beforeEach(async () => {
    // Aggressive cleanup for each test to ensure clean slate
    // NOTE: This uses clear() which can affect other test files running in parallel
    // Tests should be run individually until better database isolation is implemented
    // await registeredBridges.clear();// DISABLED: Database cleanup causing issues between test files
    // NOTE: Database cleanup disabled due to LevelDB state issues between test files
    // Each test creates its own space, so cleanup isn't strictly necessary
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  afterEach(async () => {
    // afterEach cleanup is now handled by beforeEach in the next test
  });

  describe("Reaction Add Sync", () => {
    it("RCT-D2R-01: should sync reaction add (unicode emoji)", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reaction Sync Test - ${Date.now()}`,
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
      const testContent = `Test message for reaction at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      // Sync the message to Roomy
      const roomyMessageId = await orchestrator.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );

      expect(roomyMessageId).toBeDefined();

      // Wait for message to be materialized
      await new Promise(resolve => setTimeout(resolve, 500));

      // Add a reaction to the message in Discord
      const testEmoji = { name: "👍" }; // Unicode thumbs up
      await bot.helpers.addReaction(firstChannel.id, testMessage.id, testEmoji.name);

      // Small delay to ensure reaction is added
      await new Promise(resolve => setTimeout(resolve, 200));

      // Sync the reaction to Roomy
      // Simulate the gateway event data
      const reactionEventId = await orchestrator.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id, // Bot user ID (the one who reacted)
        testEmoji,
      );

      // Verify: Reaction was synced
      expect(reactionEventId).toBeDefined();

      // Wait for reaction event to be materialized
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify: addBridgedReaction event exists
      const events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      const addReactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0"
      );

      expect(addReactionEvents.length).toBeGreaterThan(0);

      // Verify: Reaction event has correct data
      const syncedReaction = addReactionEvents.find((e: any) => e.id === reactionEventId);
      expect(syncedReaction).toBeDefined();

      // Verify: Reaction targets correct message
      expect(syncedReaction?.reactionTo).toBe(roomyMessageId);

      // Verify: Reaction has correct emoji
      expect(syncedReaction?.reaction).toBe("👍");

      // Verify: Reacting user is the bot
      expect(syncedReaction?.reactingUser).toBe(`did:discord:${bot.id}`);

      // Verify: discordReactionOrigin extension with correct snowflake
      const origin = syncedReaction?.extensions?.["space.roomy.extension.discordReactionOrigin.v0"];
      expect(origin).toBeDefined();
      expect(origin?.snowflake).toBe(reactionEventId);
      expect(origin?.messageId).toBe(testMessage.id.toString());
      expect(origin?.channelId).toBe(firstChannel.id.toString());
      expect(origin?.userId).toBe(bot.id.toString());
      expect(origin?.emoji).toBe("👍");

      // Clean up: Remove reaction and delete message
      await bot.helpers.deleteOwnReaction(firstChannel.id, testMessage.id, testEmoji.name);
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);

    it("RCT-D2R-02: should sync reaction add (custom emoji)", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Custom Emoji Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // Create a test message
      const testContent = `Test message for custom emoji at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      // Sync the message to Roomy
      const roomyMessageId = await orchestrator.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );

      expect(roomyMessageId).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 500));

      // Fetch custom emojis from the guild
      const emojis = await bot.rest.getEmojis(TEST_GUILD_ID);

      // Skip test if no custom emojis available
      if (emojis.length === 0) {
        console.warn("No custom emojis available in test guild, skipping test");
        return;
      }

      // Use the first custom emoji
      const customEmoji = emojis[0];
      const emojiString = `${customEmoji.name}:${customEmoji.id}`;

      // Add custom emoji reaction to the message
      await bot.helpers.addReaction(firstChannel.id, testMessage.id, emojiString);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Sync the reaction to Roomy
      const reactionEventId = await orchestrator.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id,
        { id: customEmoji.id, name: customEmoji.name },
      );

      // Verify: Reaction was synced
      expect(reactionEventId).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify: addBridgedReaction event exists
      const events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      const addReactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0"
      );

      expect(addReactionEvents.length).toBeGreaterThan(0);

      // Verify: Reaction event has correct data
      const syncedReaction = addReactionEvents.find((e: any) => e.id === reactionEventId);
      expect(syncedReaction).toBeDefined();
      expect(syncedReaction?.reactionTo).toBe(roomyMessageId);

      // Verify: Custom emoji format (name:id)
      expect(syncedReaction?.reaction).toBe(emojiString);

      // Verify: Extension has custom emoji data
      const origin = syncedReaction?.extensions?.["space.roomy.extension.discordReactionOrigin.v0"];
      expect(origin).toBeDefined();
      expect(origin?.emoji).toBe(emojiString);

      // Clean up
      await bot.helpers.deleteOwnReaction(firstChannel.id, testMessage.id, emojiString);
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  describe("Reaction Remove Sync", () => {
    it("RCT-D2R-03: should sync reaction remove", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reaction Remove Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // Create a test message
      const testContent = `Test message for reaction remove at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      // Sync the message
      await orchestrator.handleDiscordMessageCreate(testMessage, roomyRoomId);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Add a reaction to the message
      const testEmoji = { name: "😀" };
      await bot.helpers.addReaction(firstChannel.id, testMessage.id, testEmoji.name);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Sync the reaction add
      const reactionEventId = await orchestrator.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id,
        testEmoji,
      );

      expect(reactionEventId).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify: Reaction was added
      let events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      let addReactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0"
      );
      expect(addReactionEvents.length).toBeGreaterThan(0);

      // Remove the reaction from Discord
      await bot.helpers.deleteOwnReaction(firstChannel.id, testMessage.id, testEmoji.name);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Sync the reaction remove to Roomy
      await orchestrator.handleDiscordReactionRemove(
        testMessage.id,
        firstChannel.id,
        bot.id,
        testEmoji,
      );

      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify: removeBridgedReaction event exists
      events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      const removeReactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.removeBridgedReaction.v0"
      );

      expect(removeReactionEvents.length).toBeGreaterThan(0);

      // Verify: Remove event targets the correct reaction event
      const removeEvent = removeReactionEvents.find((e: any) => e.reactionId === reactionEventId);
      expect(removeEvent).toBeDefined();

      // Verify: Reacting user is the bot
      expect(removeEvent?.reactingUser).toBe(`did:discord:${bot.id}`);

      // Clean up
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  describe("Reaction Idempotency", () => {
    it("IDM-06: should not duplicate reactions on re-sync", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reaction Idempotency Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      const roomyRoomId = await orchestrator.handleDiscordChannelCreate(firstChannel);

      // Create a test message
      const testContent = `Test message for reaction idempotency at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      // Sync the message
      await orchestrator.handleDiscordMessageCreate(testMessage, roomyRoomId);

      await new Promise(resolve => setTimeout(resolve, 500));

      // Add a reaction to the message
      const testEmoji = { name: "🎉" };
      await bot.helpers.addReaction(firstChannel.id, testMessage.id, testEmoji.name);

      await new Promise(resolve => setTimeout(resolve, 200));

      // First sync of the reaction
      const reactionId1 = await orchestrator.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id,
        testEmoji,
      );

      expect(reactionId1).toBeDefined();

      await new Promise(resolve => setTimeout(resolve, 500));

      let events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      let reactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0"
      );

      // Second sync with same reaction data (should be idempotent)
      const reactionId2 = await orchestrator.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id,
        testEmoji,
      );

      await new Promise(resolve => setTimeout(resolve, 500));

      events = (await result.connectedSpace.fetchEvents(1, 200)).map((e: any) => e.event);
      reactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0"
      );

      // Verify: Same reaction ID returned (idempotent)
      expect(reactionId1).toBe(reactionId2);

      // Verify: No new reaction event created
      const newReactionEvents = reactionEvents.filter((e: any) => e.id === reactionId1);
      expect(newReactionEvents.length).toBe(1);

      // Clean up
      await bot.helpers.deleteOwnReaction(firstChannel.id, testMessage.id, testEmoji.name);
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  describe("Edge Cases", () => {
    it("should skip reaction sync for unsynced message", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reaction Edge Case Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      await orchestrator.handleDiscordChannelCreate(firstChannel);

      // Create a message but DON'T sync it
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: `Unsynced message at ${Date.now()}`,
      });

      // Try to sync a reaction for the unsynced message
      const testEmoji = { name: "❌" };
      const reactionEventId = await orchestrator.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id,
        testEmoji,
      );

      // Verify: Reaction sync was skipped (returns null)
      expect(reactionEventId).toBeNull();

      // Clean up
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);

    it("should skip reaction sync for unsynced channel", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reaction Edge Case Test 2 - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Use a channel but DON'T sync it
      const firstChannel = channels[0];

      // Create a message in the unsynced channel
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: `Message in unsynced channel at ${Date.now()}`,
      });

      // Try to sync a reaction for a message in an unsynced channel
      const testEmoji = { name: "⚠️" };
      const reactionEventId = await orchestrator.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id,
        testEmoji,
      );

      // Verify: Reaction sync was skipped (returns null)
      expect(reactionEventId).toBeNull();

      // Clean up
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });
});
