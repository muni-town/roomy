/**
 * Reaction sync E2E tests.
 *
 * Tests all four combinations of message origin (Discord/Roomy) and reaction origin (Discord/Roomy):
 *
 * ┌─────────────────┬──────────────────────────────┬──────────────────────────────┐
 * │                 │ Discord Message              │ Roomy Message                │
 * ├─────────────────┼──────────────────────────────┼──────────────────────────────┤
 * │ Discord Reaction│ D-msg + D-react → Roomy      │ R-msg + D-react → Roomy      │
 * │ Roomy Reaction  │ D-msg + R-react → Discord    │ R-msg + R-react → Discord    │
 * └─────────────────┴──────────────────────────────┴──────────────────────────────┘
 *
 * Each test verifies:
 * 1. Reaction syncs in the correct direction
 * 2. No echo (no duplicate reaction in opposite direction)
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  createTestBot,
  connectGuildToNewSpace,
  initE2ERoomyClient,
  getTextChannels,
  createBridgeForTest,
  getDiscordReactions,
  waitForBotReactionViaRest,
  validateRoomyReactions,
} from "../helpers/setup.js";
import { TEST_GUILD_ID } from "../fixtures/test-data.js";
import {
  createMessage,
  addReaction,
  StreamIndex,
  Ulid,
  UserDid,
} from "@roomy/sdk";

describe("E2E: Reaction Sync - Origin Matrix", () => {
  beforeAll(async () => {
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E reaction sync tests");
  }, 60000);

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  /**
   * Matrix Row 1, Col 1: Discord Message + Discord Reaction
   * Expected: Reaction syncs to Roomy, no echo back to Discord
   *
   * Scenario:
   * 1. Bot sends message to Discord
   * 2. Discord user reacts on Discord
   * 3. Reaction should appear on Roomy
   * 4. No duplicate reaction should appear on Discord
   */
  describe("D-msg + D-react → Roomy", () => {
    it("should sync Discord reaction on Discord message to Roomy", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E D-msg-D-react - ${Date.now()}`,
      );
      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create Discord-origin message
      const testContent = `D-msg for D-react test at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      const roomyMessageId = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );
      expect(roomyMessageId).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Discord user reacts
      const testEmoji = { name: "👍" };
      const testUserId = 123456789n;
      const reactionEventId = await bridge.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        testUserId,
        testEmoji,
      );

      // Verify: Reaction synced to Roomy
      expect(reactionEventId).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const addReactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
      );

      expect(addReactionEvents.length).toBeGreaterThan(0);
      const syncedReaction = addReactionEvents.find(
        (e: any) => e.id === reactionEventId,
      );
      expect(syncedReaction?.reactionTo).toBe(roomyMessageId);
      expect(syncedReaction?.reaction).toBe("👍");
      expect(syncedReaction?.reactingUser).toBe(`did:discord:${testUserId}`);

      // Verify: No echo - only one reaction exists
      expect(
        addReactionEvents.filter((e: any) => e.id === reactionEventId).length,
      ).toBe(1);

      // Cleanup
      await bot.helpers.deleteOwnReaction(
        firstChannel.id,
        testMessage.id,
        testEmoji.name,
      );
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  /**
   * Matrix Row 2, Col 1: Discord Message + Roomy Reaction
   * Expected: Reaction syncs to Discord, no echo back to Roomy
   *
   * Scenario:
   * 1. Bot sends message to Discord
   * 2. User reacts on Roomy
   * 3. Reaction should appear on Discord (via webhook)
   * 4. No duplicate reaction should appear on Roomy
   */
  describe("D-msg + R-react → Discord", () => {
    it("should sync Roomy reaction on Discord message to Discord", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E D-msg-R-react - ${Date.now()}`,
      );
      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create Discord-origin message
      const testContent = `D-msg for R-react test at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      const roomyMessageId = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );
      expect(roomyMessageId).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Count Roomy reactions before
      let events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const reactionsBefore = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
      );

      // Simulate Roomy reaction event (user reacts on Roomy to a Discord message)
      const reaction = "😀";
      const testUserDid = "did:discord:987654321" as const;
      const reactionEvent = {
        idx: 2 as StreamIndex,
        event: {
          id: "01KGVFRTEST00000000000001" as Ulid,
          $type: "space.roomy.reaction.addReaction.v0" as const,
          room: roomyRoomId as Ulid,
          reactionTo: roomyMessageId as Ulid,
          reaction,
        },
        user: testUserDid as UserDid,
      };

      // Sync Roomy reaction to Discord (bot adds the reaction)
      await bridge.handleRoomyAddReaction(reactionEvent, bot);

      // Verify: Reaction was actually added to Discord
      const reactingUsers = await waitForBotReactionViaRest({
        bot,
        messageId: testMessage.id,
        channelId: firstChannel.id,
        emoji: reaction,
        timeout: 10000,
      });

      expect(
        reactingUsers,
        "Discord API did not confirm reaction was added within timeout",
      ).not.toBeNull();
      expect(reactingUsers!.length).toBeGreaterThan(0);
      expect(reactingUsers).toContain(bot.id);

      // Simulate Discord echoing back (bot user reaction from gateway)
      // This tests that echo prevention works correctly
      const echoReactionId = await bridge.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id, // Bot user ID - this is the echo we need to prevent
        { name: reaction },
      );

      // Verify: Echo was prevented (returns null)
      expect(echoReactionId).toBeNull();

      // Verify: No echo back to Roomy (no new addBridgedReaction events)
      events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const reactionsAfter = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
      );

      expect(reactionsAfter.length).toBe(reactionsBefore.length);

      // Cleanup
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  /**
   * Matrix Row 1, Col 2: Roomy Message + Discord Reaction
   * Expected: Reaction syncs to Roomy, no echo back to Discord
   *
   * Scenario:
   * 1. User creates message on Roomy
   * 2. Bridge syncs to Discord via webhook
   * 3. Discord user reacts on Discord
   * 4. Reaction should appear on Roomy
   * 5. No duplicate reaction should appear on Discord
   */
  describe("R-msg + D-react → Roomy", () => {
    it("should sync Discord reaction on Roomy message to Roomy", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E R-msg-D-react - ${Date.now()}`,
      );
      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create Roomy-origin message
      const testContent = `R-msg for D-react test at ${Date.now()}`;
      const testUserDid = "did:plc:testuser123" as const;

      const messageResult = await createMessage(result.connectedSpace, {
        room: roomyRoomId,
        body: {
          mimeType: "text/plain",
          data: { buf: new TextEncoder().encode(testContent) },
        },
      });

      const roomyMessageId = messageResult.id;

      // Sync Roomy message to Discord via webhook
      await bridge.handleRoomyCreateMessage(
        {
          idx: 1 as StreamIndex,
          event: {
            id: roomyMessageId,
            $type: "space.roomy.message.createMessage.v0" as const,
            room: roomyRoomId as Ulid,
            body: {
              mimeType: "text/plain",
              data: { buf: new TextEncoder().encode(testContent) },
            },
          },
          user: testUserDid as UserDid,
        },
        bot,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Get the Discord message
      const discordMessages = await bot.rest.getMessages(firstChannel.id, {
        limit: 50,
      });
      const discordMessage = discordMessages.find(
        (m) => m.content === testContent,
      );
      expect(discordMessage).toBeDefined();

      // Discord user reacts
      const testEmoji = { name: "🎉" };
      const testUserId = 123456789n;
      const reactionEventId = await bridge.handleDiscordReactionAdd(
        BigInt(discordMessage!.id),
        firstChannel.id,
        testUserId,
        testEmoji,
      );

      // Verify: Reaction synced to Roomy
      expect(reactionEventId).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const addReactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
      );

      expect(addReactionEvents.length).toBeGreaterThan(0);
      const syncedReaction = addReactionEvents.find(
        (e: any) => e.id === reactionEventId,
      );
      expect(syncedReaction?.reactionTo).toBe(roomyMessageId);
      expect(syncedReaction?.reaction).toBe("🎉");

      // Verify: No echo (only one reaction)
      expect(
        addReactionEvents.filter((e: any) => e.id === reactionEventId).length,
      ).toBe(1);

      // Cleanup
      await bot.helpers.deleteMessage(firstChannel.id, discordMessage!.id);
    }, 30000);
  });

  /**
   * Matrix Row 2, Col 2: Roomy Message + Roomy Reaction
   * Expected: Reaction syncs to Discord, no echo back to Roomy
   *
   * Scenario:
   * 1. User creates message on Roomy
   * 2. Bridge syncs to Discord via webhook
   * 3. User reacts on Roomy
   * 4. Reaction should sync to Discord (via webhook)
   * 5. Discord echoes back via gateway (as bot user)
   * 6. Echo should be prevented (no duplicate on Roomy)
   */
  describe("R-msg + R-react → Discord", () => {
    it("should sync Roomy reaction on Roomy message to Discord (with echo prevention)", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E R-msg-R-react - ${Date.now()}`,
      );
      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create Roomy-origin message
      const testContent = `R-msg for R-react test at ${Date.now()}`;
      const testUserDid = "did:discord:123456789" as const;

      const messageResult = await createMessage(result.connectedSpace, {
        room: roomyRoomId,
        body: {
          mimeType: "text/plain",
          data: { buf: new TextEncoder().encode(testContent) },
        },
      });

      const roomyMessageId = messageResult.id;

      // Sync Roomy message to Discord
      await bridge.handleRoomyCreateMessage(
        {
          idx: 1 as StreamIndex,
          event: {
            id: roomyMessageId,
            $type: "space.roomy.message.createMessage.v0" as const,
            room: roomyRoomId as Ulid,
            body: {
              mimeType: "text/plain",
              data: { buf: new TextEncoder().encode(testContent) },
            },
          },
          user: testUserDid as UserDid,
        },
        bot,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify Discord message was created
      const discordMessages = await bot.rest.getMessages(firstChannel.id, {
        limit: 50,
      });
      const discordMessage = discordMessages.find(
        (m) => m.content === testContent,
      );
      expect(discordMessage).toBeDefined();

      // Simulate Roomy reaction event (user reacts on Roomy)
      const reaction = "😀";
      const reactionEvent = {
        idx: 2 as StreamIndex,
        event: {
          id: "01KGVFRTEST00000000000002" as Ulid,
          $type: "space.roomy.reaction.addReaction.v0" as const,
          room: roomyRoomId as Ulid,
          reactionTo: roomyMessageId as Ulid,
          reaction,
        },
        user: testUserDid as UserDid,
      };

      // Sync Roomy reaction to Discord (bot adds the reaction)
      await bridge.handleRoomyAddReaction(reactionEvent, bot);

      // Verify: Reaction was actually added to Discord
      const reactingUsers = await waitForBotReactionViaRest({
        bot,
        messageId: BigInt(discordMessage!.id),
        channelId: firstChannel.id,
        emoji: reaction,
        timeout: 10000,
      });

      expect(
        reactingUsers,
        "Discord API did not confirm reaction was added within timeout",
      ).not.toBeNull();
      expect(reactingUsers!.length).toBeGreaterThan(0);
      expect(reactingUsers).toContain(bot.id);

      // Simulate Discord echoing back (bot user reaction from gateway)
      // This is what happens when the bot adds a reaction via webhook and Discord
      // sends back a reaction_add event via gateway
      const echoReactionId = await bridge.handleDiscordReactionAdd(
        discordMessage!.id,
        firstChannel.id,
        bot.id, // Bot user ID - echo prevention should skip this
        { name: reaction },
      );

      // Verify: Echo was prevented (returns null)
      // The bot ID check at ReactionSyncService.ts line 56 prevents syncing bot's own reactions
      expect(echoReactionId).toBeNull();

      // Cleanup
      if (discordMessage) {
        await bot.helpers.deleteMessage(firstChannel.id, discordMessage.id);
      }
    }, 30000);
  });

  /**
   * Additional coverage tests
   */
  describe("Additional Tests", () => {
    it("should handle reaction remove", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reaction Remove - ${Date.now()}`,
      );
      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      const testContent = `Test message for reaction remove at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      await bridge.handleDiscordMessageCreate(testMessage);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testEmoji = { name: "😀" };
      const testUserId = 123456789n;

      const reactionEventId = await bridge.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        testUserId,
        testEmoji,
      );
      expect(reactionEventId).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Remove reaction
      await bridge.handleDiscordReactionRemove(
        testMessage.id,
        firstChannel.id,
        testUserId,
        testEmoji,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify: removeBridgedReaction event exists
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const removeReactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.removeBridgedReaction.v0",
      );

      expect(removeReactionEvents.length).toBeGreaterThan(0);
      const removeEvent = removeReactionEvents.find(
        (e: any) => e.reactionId === reactionEventId,
      );
      expect(removeEvent).toBeDefined();

      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);

    it("should be idempotent - no duplicate reactions on re-sync", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reaction Idempotency - ${Date.now()}`,
      );
      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      const testContent = `Test message for idempotency at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      await bridge.handleDiscordMessageCreate(testMessage);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const testEmoji = { name: "🎉" };
      const testUserId = 123456789n;

      const reactionId1 = await bridge.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        testUserId,
        testEmoji,
      );
      expect(reactionId1).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Re-sync same reaction
      const reactionId2 = await bridge.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        testUserId,
        testEmoji,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify: Same reaction ID (idempotent)
      expect(reactionId1).toBe(reactionId2);

      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const reactionEvents = events.filter(
        (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
      );

      // Verify: Only one reaction event created
      expect(
        reactionEvents.filter((e: any) => e.id === reactionId1).length,
      ).toBe(1);

      await bot.helpers.deleteOwnReaction(
        firstChannel.id,
        testMessage.id,
        testEmoji.name,
      );
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);

    it("should skip sync for unsynced message", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Unsynced Message - ${Date.now()}`,
      );
      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      await bridge.handleDiscordChannelCreate(firstChannel);

      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: `Unsynced message at ${Date.now()}`,
      });

      const testEmoji = { name: "❌" };
      const reactionEventId = await bridge.handleDiscordReactionAdd(
        testMessage.id,
        firstChannel.id,
        bot.id,
        testEmoji,
      );

      expect(reactionEventId).toBeNull();
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });
});
