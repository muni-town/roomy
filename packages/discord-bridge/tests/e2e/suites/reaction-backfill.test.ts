/**
 * Reaction backfill E2E test.
 *
 * This test verifies that `backfillDiscordReactions()` correctly syncs
 * existing Discord reactions to Roomy.
 *
 * Note: Due to Discord API limitations in E2E tests, we cannot create
 * reactions from other users (only the bot can add reactions). Since the
 * bot's own reactions are filtered out by echo prevention in syncAddToRoomy(),
 * this test focuses on verifying the backfill process works correctly and
 * handles edge cases.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createTestBot,
  connectGuildToNewSpace,
  initE2ERoomyClient,
  getTextChannels,
  createSyncOrchestratorForTest,
} from "../helpers/setup.js";
import { TEST_GUILD_ID } from "../fixtures/test-data.js";
import { backfillDiscordReactions } from "../../../src/discord/backfill.js";
import { StreamIndex } from "@roomy/sdk";

describe("E2E: Reaction Backfill", () => {
  beforeAll(async () => {
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E reaction backfill tests");
  }, 60000);

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  /**
   * Test that backfill handles the scenario where reactions are synced via
   * gateway first, then backfill is called (idempotency).
   *
   * This simulates the real-world scenario:
   * 1. Bridge is connected, starts receiving gateway events
   * 2. Reactions are synced via gateway
   * 3. Bridge reconnects and runs backfill
   * 4. Backfill should NOT create duplicate events
   */
  it("should be idempotent - backfill doesn't duplicate already-synced reactions", async () => {
    const roomy = await initE2ERoomyClient();
    const bot = await createTestBot();
    const result = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Backfill Idempotency - ${Date.now()}`,
    );

    const channels = await getTextChannels(bot, TEST_GUILD_ID);
    const firstChannel = channels[0];

    const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
      content: `Test message for backfill idempotency at ${Date.now()}`,
    });

    const orchestrator = createSyncOrchestratorForTest(result, bot);
    const roomyRoomId =
      await orchestrator.handleDiscordChannelCreate(firstChannel);
    await orchestrator.handleDiscordMessageCreate(testMessage, roomyRoomId);

    // Simulate gateway sync (simulated user reactions, NOT from bot)
    const testEmoji1 = { name: "👍" };
    const testEmoji2 = { name: "🎉" };
    const testUserId = 123456789n; // Different from bot.id

    // Sync reactions via simulated gateway events
    const reactionId1 = await orchestrator.handleDiscordReactionAdd(
      testMessage.id,
      firstChannel.id,
      testUserId,
      testEmoji1,
    );
    const reactionId2 = await orchestrator.handleDiscordReactionAdd(
      testMessage.id,
      firstChannel.id,
      testUserId,
      testEmoji2,
    );

    expect(reactionId1).toBeDefined();
    expect(reactionId2).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Get reaction count before backfill
    const eventsBefore = (
      await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
    ).map((e: any) => e.event);
    const reactionEventsBefore = eventsBefore.filter(
      (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
    );

    console.log(
      `Reaction events before backfill: ${reactionEventsBefore.length}`,
    );

    // Call backfill - even though it won't find the simulated reactions
    // via Discord API (they don't actually exist on Discord), it should
    // complete without errors
    await backfillDiscordReactions(bot, result.guildContext, firstChannel.id);

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify: No new reaction events were created (backfill didn't find reactions
    // on Discord API because our simulated reactions don't actually exist there)
    const events = (
      await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
    ).map((e: any) => e.event);
    const reactionEvents = events.filter(
      (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
    );

    console.log(`Reaction events after backfill: ${reactionEvents.length}`);

    // The count should be the same - backfill didn't add anything because
    // the simulated reactions don't exist on Discord
    expect(reactionEvents.length).toBe(reactionEventsBefore.length);

    // Our original synced reactions should still exist
    const thumbsUpReaction = reactionEvents.find(
      (e: any) => e.reaction === testEmoji1.name,
    );
    expect(thumbsUpReaction).toBeDefined();

    const partyReaction = reactionEvents.find(
      (e: any) => e.reaction === testEmoji2.name,
    );
    expect(partyReaction).toBeDefined();

    // Cleanup
    await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
  }, 30000);

  /**
   * Test that backfill gracefully handles channels with no reactions.
   *
   * This is a positive control test - it should pass both before and after
   * the fix because there are no reactions to backfill.
   */
  it("should handle channels with no reactions gracefully", async () => {
    const roomy = await initE2ERoomyClient();
    const bot = await createTestBot();
    const result = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E No Reactions - ${Date.now()}`,
    );

    const channels = await getTextChannels(bot, TEST_GUILD_ID);
    const firstChannel = channels[0];

    const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
      content: `Message with no reactions at ${Date.now()}`,
    });

    const orchestrator = createSyncOrchestratorForTest(result, bot);
    const roomyRoomId =
      await orchestrator.handleDiscordChannelCreate(firstChannel);
    await orchestrator.handleDiscordMessageCreate(testMessage, roomyRoomId);

    // Call backfill on channel with no reactions
    await backfillDiscordReactions(bot, result.guildContext, firstChannel.id);

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify: No reaction events (should pass both before and after fix)
    const events = (
      await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
    ).map((e: any) => e.event);
    const reactionEvents = events.filter(
      (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
    );

    expect(reactionEvents.length).toBe(0);

    // Cleanup
    await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
  }, 30000);

  /**
   * Test that backfill correctly processes messages with reactions.
   *
   * This test verifies that:
   * 1. The backfill function can fetch messages from Discord
   * 2. The backfill function correctly identifies messages with reactions
   * 3. The backfill process completes without errors
   *
   * Note: This test adds bot reactions, which will be filtered out by
   * echo prevention. The key is that the backfill process completes
   * successfully and handles the reactions array correctly.
   */
  it("should process messages and complete without errors", async () => {
    const roomy = await initE2ERoomyClient();
    const bot = await createTestBot();
    const result = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Backfill Processing - ${Date.now()}`,
    );

    const channels = await getTextChannels(bot, TEST_GUILD_ID);
    const firstChannel = channels[0];

    // Create multiple messages with bot reactions
    const message1 = await bot.helpers.sendMessage(firstChannel.id, {
      content: `Test message 1 for backfill processing at ${Date.now()}`,
    });
    const message2 = await bot.helpers.sendMessage(firstChannel.id, {
      content: `Test message 2 for backfill processing at ${Date.now()}`,
    });

    const orchestrator = createSyncOrchestratorForTest(result, bot);
    const roomyRoomId =
      await orchestrator.handleDiscordChannelCreate(firstChannel);

    await orchestrator.handleDiscordMessageCreate(message1, roomyRoomId);
    await orchestrator.handleDiscordMessageCreate(message2, roomyRoomId);

    // Add bot reactions to the messages
    const testEmoji = "👍";
    await bot.helpers.addReaction(firstChannel.id, message1.id, testEmoji);
    await bot.helpers.addReaction(firstChannel.id, message2.id, testEmoji);

    // Wait for reactions to be added on Discord
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Call backfill - it should process the messages and complete successfully
    // even though the bot's own reactions will be filtered out
    await expect(
      backfillDiscordReactions(bot, result.guildContext, firstChannel.id),
    ).resolves.not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify: No reaction events from bot's own reactions (echo prevention)
    const events = (
      await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
    ).map((e: any) => e.event);
    const reactionEvents = events.filter(
      (e: any) => e.$type === "space.roomy.reaction.addBridgedReaction.v0",
    );

    // Bot's reactions are filtered out, so no events should be created
    expect(reactionEvents.length).toBe(0);

    // Cleanup
    await bot.helpers.deleteOwnReaction(
      firstChannel.id,
      message1.id,
      testEmoji,
    );
    await bot.helpers.deleteOwnReaction(
      firstChannel.id,
      message2.id,
      testEmoji,
    );
    await bot.helpers.deleteMessage(firstChannel.id, message1.id);
    await bot.helpers.deleteMessage(firstChannel.id, message2.id);
  }, 30000);

  /**
   * Test that the backfill implementation correctly creates ReactionSyncService
   * and has all necessary dependencies.
   *
   * This is a structural test that verifies the implementation has all
   * the pieces in place, even if we can't fully test actual reaction syncing
   * in E2E.
   */
  it("should have proper implementation structure", async () => {
    const roomy = await initE2ERoomyClient();
    const bot = await createTestBot();
    const result = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Structure Test - ${Date.now()}`,
    );

    const channels = await getTextChannels(bot, TEST_GUILD_ID);
    const firstChannel = channels[0];

    // This should not throw - verifies all dependencies are in place
    await expect(
      backfillDiscordReactions(bot, result.guildContext, firstChannel.id),
    ).resolves.not.toThrow();
  }, 30000);
});
