/**
 * Basic sync E2E tests.
 * Tests core Discord -> Roomy sync functionality:
 * - Channel creation
 * - Message sync (future)
 * - Sidebar structure (future)
 *
 * @vitest-environment node
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import {
  createTestBot,
  connectGuildToNewSpace,
  initE2ERoomyClient,
  getTextChannels,
  getCategories,
  createBridgeForTest,
  cleanupRoomySyncedChannels,
} from "../helpers/setup.js";
import { getLatestSidebarEvent } from "../helpers/assertions.js";
import { TEST_GUILD_ID } from "../fixtures/test-data.js";
import { registeredBridges } from "../../../src/repositories/LevelDBBridgeRepository.js";
import { createRoom } from "@roomy/sdk/package/operations/room";
import { createMessage } from "@roomy/sdk/package/operations/message";
import { ConnectedSpace, StreamIndex } from "@roomy/sdk";

const connectedSpaces = new Map<string, ConnectedSpace>();

describe("E2E: Discord Channel Sync", () => {
  beforeAll(async () => {
    // Initialize Roomy client once
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E channel sync tests");

    // Clean up any channels with Roomy sync marker from previous test runs
    const bot = await createTestBot();
    const deletedCount = await cleanupRoomySyncedChannels(bot, TEST_GUILD_ID);
    console.log(
      `Cleaned up ${deletedCount} Roomy-synced channels from previous test runs`,
    );
  }, 60000);

  beforeEach(async () => {
    // Aggressive cleanup for each test to ensure clean slate
    // NOTE: This uses clear() which can affect other test files running in parallel
    // Tests should be run individually until better database isolation is implemented
    await registeredBridges.clear();
    // Also clear connectedSpaces
    const bridges = await registeredBridges.list();
    for (const bridge of bridges) {
      connectedSpaces.delete(bridge.spaceId);
    }
    // Delay to ensure LevelDB operations are flushed
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    // afterEach cleanup is now handled by beforeEach in the next test
  });

  describe("Unit-level: Individual Channel Sync", () => {
    it("should sync a single Discord channel to Roomy", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Single Channel Test - ${Date.now()}`,
      );

      // Create bridge
      const bridge = await createBridgeForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Verify: A createRoom event was created
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 100)
      ).map((e: any) => e.event);
      const createRoomEvents = events.filter(
        (e: any) => e.$type === "space.roomy.room.createRoom.v0",
      );
      expect(createRoomEvents.length).toBeGreaterThan(0);

      // Verify: The createRoom event has correct kind and name
      const channelEvent = createRoomEvents.find(
        (e: any) => e.id === roomyRoomId,
      );
      expect(channelEvent).toBeDefined();
      expect(channelEvent?.kind).toBe("space.roomy.channel");
      expect(channelEvent?.name).toBe(firstChannel.name);

      // Verify: discordOrigin extension with correct snowflake
      const origin =
        channelEvent?.extensions?.["space.roomy.extension.discordOrigin.v0"];
      expect(origin).toBeDefined();
      expect(origin?.snowflake).toBe(firstChannel.id.toString());

      // Verify: Mapping exists in syncedIds
      const roomKey = `room:${firstChannel.id.toString()}`;
      const mappedRoomyId =
        await result.guildContext.syncedIds.get_discordId(roomKey);
      expect(mappedRoomyId).toBe(roomyRoomId);
    });

    it("should sync multiple Discord channels to Roomy", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Multiple Channels Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync all channels
      const roomyIds: string[] = [];
      for (const channel of channels) {
        const roomId = await bridge.handleDiscordChannelCreate(channel);
        roomyIds.push(roomId);
      }

      // Verify all channels were synced
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const createRoomEvents = events.filter(
        (e: any) =>
          e.$type === "space.roomy.room.createRoom.v0" &&
          e.kind === "space.roomy.channel",
      );

      // Should have one createRoom per channel (plus lobby from default space)
      expect(createRoomEvents.length).toBeGreaterThanOrEqual(channels.length);

      // Verify each Discord channel has a corresponding Roomy room
      for (const channel of channels) {
        const channelIdStr = channel.id.toString();
        const matchingEvent = createRoomEvents.find((e: any) => {
          const origin =
            e.extensions?.["space.roomy.extension.discordOrigin.v0"];
          return origin?.snowflake === channelIdStr;
        });
        expect(matchingEvent).toBeDefined();
        expect(matchingEvent?.name).toBe(channel.name);
      }

      // Verify all mappings exist in syncedIds
      for (const channel of channels) {
        const roomKey = `room:${channel.id.toString()}`;
        const mappedRoomyId =
          await result.guildContext.syncedIds.get_discordId(roomKey);
        expect(mappedRoomyId).toBeDefined();
      }
    });
  });

  describe("Idempotency", () => {
    it("should not duplicate channels on re-sync", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Idempotency Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];

      // First sync
      const roomId1 =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Get event count after first sync
      const events1 = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 100)
      ).map((e: any) => e.event);
      const channelEvents1 = events1.filter(
        (e: any) =>
          e.$type === "space.roomy.room.createRoom.v0" &&
          e.kind === "space.roomy.channel",
      );

      // Second sync with same channel
      const roomId2 =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Get event count after second sync
      const events2 = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 100)
      ).map((e: any) => e.event);
      const channelEvents2 = events2.filter(
        (e: any) =>
          e.$type === "space.roomy.room.createRoom.v0" &&
          e.kind === "space.roomy.channel",
      );

      // Verify: Same room ID returned
      expect(roomId1).toBe(roomId2);

      // Verify: No new createRoom event created
      expect(channelEvents2.length).toBe(channelEvents1.length);
    }, 15000);
  });

  describe("Integration-level: Full Sidebar Sync", () => {
    it("should sync channels and update sidebar", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Sidebar Sync Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      // Fetch channels and categories from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const categories = await getCategories(bot, TEST_GUILD_ID);

      expect(channels.length).toBeGreaterThan(0);

      // First sync all individual channels
      for (const channel of channels) {
        await bridge.handleDiscordChannelCreate(channel);
      }

      // Then sync the sidebar
      await bridge.handleDiscordSidebarUpdate(channels, categories);

      // Verify: sidebar update event exists
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const sidebarEvents = events.filter(
        (e: any) => e.$type === "space.roomy.space.updateSidebar.v0" ||
          e.$type === "space.roomy.space.updateSidebar.v1",
      );

      expect(sidebarEvents.length).toBeGreaterThan(0);

      // The latest sidebar event should have our categories
      const latestSidebar = sidebarEvents[sidebarEvents.length - 1];
      expect(latestSidebar.categories).toBeDefined();
      expect(Array.isArray(latestSidebar.categories)).toBe(true);

      console.log(
        `Synced ${channels.length} channels with ${latestSidebar.categories.length} categories`,
      );
    }, 15000);
  });

  describe("Category Sync (Discord → Roomy)", () => {
    it.skip("should create sidebar categories matching Discord structure", async () => {
      // SKIP: Redundant with integration-level test, timing out due to Leaf issues
      // TODO: Re-enable when Leaf is more stable or tests are run in isolation
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Category Sync Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      // Fetch channels and categories from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const categories = await getCategories(bot, TEST_GUILD_ID);

      // Sync all channels first
      for (const channel of channels) {
        await bridge.handleDiscordChannelCreate(channel);
      }

      // Sync the sidebar
      await bridge.handleDiscordSidebarUpdate(channels, categories);

      // Verify: sidebar was created
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const sidebar = getLatestSidebarEvent(events);

      // Should have categories (at least "general" for uncategorized)
      expect(sidebar.categories.length).toBeGreaterThan(0);

      console.log(`Created ${sidebar.categories.length} categories`);
    });

    it.skip("should group channels under correct Discord categories", async () => {
      // SKIP: Redundant with integration-level test, timing out due to Leaf issues
      // TODO: Re-enable when Leaf is more stable or tests are run in isolation
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Category Grouping Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      // Fetch channels and categories from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const categories = await getCategories(bot, TEST_GUILD_ID);

      // Group Discord channels by category for verification
      const channelsByCategory = new Map<string, (typeof channels)[]>();
      for (const channel of channels) {
        const categoryName = channel.parentId
          ? categories.find((c) => c.id === channel.parentId)?.name || "general"
          : "general";
        if (!channelsByCategory.has(categoryName)) {
          channelsByCategory.set(categoryName, []);
        }
        channelsByCategory.get(categoryName)!.push([channel]);
      }

      // Sync all channels
      const channelMap = new Map<
        string /* channelId */,
        string /* roomyId */
      >();
      for (const channel of channels) {
        const roomId = await bridge.handleDiscordChannelCreate(channel);
        channelMap.set(channel.id.toString(), roomId);
      }

      // Sync the sidebar
      await bridge.handleDiscordSidebarUpdate(channels, categories);

      // Verify: each Discord category exists in Roomy sidebar
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const sidebar = getLatestSidebarEvent(events);

      // Check each category from Discord
      for (const [categoryName, categoryChannels] of channelsByCategory) {
        // Find the category in sidebar
        const sidebarCategory = sidebar.categories.find(
          (c: any) => c.name === categoryName,
        );

        // Category should exist (unless it's empty and got filtered)
        if (categoryChannels.length > 0) {
          expect(sidebarCategory).toBeDefined();
          expect(sidebarCategory?.children.length).toBe(
            categoryChannels.length,
          );

          // Verify each channel is in the correct category
          for (const channel of categoryChannels) {
            const roomyId = channelMap.get(channel.id.toString());
            expect(roomyId).toBeDefined();
            expect(sidebarCategory?.children).toContain(roomyId);
          }
        }
      }

      console.log(
        `Verified ${channelsByCategory.size} categories with ${channels.length} channels`,
      );
    }, 30000);

    it.skip("should handle uncategorized channels", async () => {
      // SKIP: This test times out due to Leaf server issues after multiple rapid stream creations
      // The core functionality is tested in other category sync tests
      // TODO: Re-enable when Leaf materialization is more stable
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Uncategorized Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const categories = await getCategories(bot, TEST_GUILD_ID);

      // Find uncategorized channels (no parentId)
      const uncategorized = channels.filter((c) => !c.parentId);

      // Sync all channels
      for (const channel of channels) {
        await bridge.handleDiscordChannelCreate(channel);
      }

      // Sync the sidebar
      await bridge.handleDiscordSidebarUpdate(channels, categories);

      // Wait for events to be materialized
      await new Promise((resolve) => setTimeout(resolve, 500));

      // If there are uncategorized channels, they should go into "general" category
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const sidebar = getLatestSidebarEvent(events);

      // The "general" category should exist (for uncategorized channels)
      const generalCategory = sidebar.categories.find(
        (c: any) => c.name === "general",
      );

      if (uncategorized.length > 0) {
        expect(generalCategory).toBeDefined();
        expect(generalCategory?.children.length).toBeGreaterThanOrEqual(
          uncategorized.length,
        );
      }

      console.log(
        `Found ${uncategorized.length} uncategorized channels, "general" category has ${generalCategory?.children.length || 0} children`,
      );
    }, 30000);

    it("should be idempotent - sidebar hash prevents duplicate updates", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Sidebar Idempotency Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const categories = await getCategories(bot, TEST_GUILD_ID);

      // Sync all channels
      for (const channel of channels) {
        await bridge.handleDiscordChannelCreate(channel);
      }

      // First sidebar sync
      await bridge.handleDiscordSidebarUpdate(channels, categories);

      // Wait for events to be materialized
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events1 = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const sidebarEvents1 = events1.filter(
        (e: any) => e.$type === "space.roomy.space.updateSidebar.v0" ||
          e.$type === "space.roomy.space.updateSidebar.v1",
      );

      // Second sidebar sync with same data should skip (hash check)
      await bridge.handleDiscordSidebarUpdate(channels, categories);

      const events2 = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const sidebarEvents2 = events2.filter(
        (e: any) => e.$type === "space.roomy.space.updateSidebar.v0" ||
          e.$type === "space.roomy.space.updateSidebar.v1",
      );

      // Should not have created a new sidebar event
      expect(sidebarEvents2.length).toBe(sidebarEvents1.length);
    }, 30000);
  });

  describe("Roomy → Discord Sync (Reverse)", () => {
    it("should create Discord channel for Roomy room without discordOrigin", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const testId = Date.now().toString();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reverse Sync Test - ${testId}`,
      );
      const orchestrator = createBridgeForTest(result, bot);

      const { createRoom, updateSidebarEvents } = await import("@roomy/sdk");

      const uniqueName = `test-roomy-channel-${testId}`;
      const roomEvents = createRoom({
        kind: "space.roomy.channel",
        name: uniqueName,
      });

      for (const event of roomEvents) {
        await result.connectedSpace.sendEvent(event);
      }

      const roomResult = { id: roomEvents[0].id };

      const sidebarEvent = updateSidebarEvents([
        { name: "Test", children: [roomResult.id] },
      ]);
      await result.connectedSpace.sendEvent(sidebarEvent);
      await new Promise((resolve) => setTimeout(resolve, 500));

      await bridge.handleRoomyUpdateSidebar(
        { idx: 1, event: sidebarEvent, user: "did:plc:test" as any },
        bot,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const channels = await bot.rest.getChannels(TEST_GUILD_ID);
      const synced = [...channels.values()].find(
        (ch) => ch.name === uniqueName,
      );
      expect(synced).toBeDefined();
      expect(synced?.topic).toContain(`[Synced from Roomy: ${roomResult.id}]`);
    }, 30000);

    it("should skip sync for Roomy room with discordOrigin extension", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reverse Skip Test - ${Date.now()}`,
      );
      const orchestrator = createBridgeForTest(result, bot);

      // First: sync a Discord channel to Roomy (adds discordOrigin)
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);
      await bridge.handleDiscordChannelCreate(channels[0]);

      // Get channel count before reverse sync
      const channelsBefore = await bot.rest.getChannels(TEST_GUILD_ID);
      const countBefore = channelsBefore.size;

      // Create a sidebar update that includes the synced Discord channel
      const { updateSidebarEvents } = await import("@roomy/sdk");
      const events = await result.connectedSpace.fetchEvents(1 as any, 100);
      const createRoomEvents = events.filter(
        (e: any) => e.event.$type === "space.roomy.room.createRoom.v0",
      );
      expect(createRoomEvents.length).toBeGreaterThan(0);

      // Find the synced Discord channel (has discordOrigin extension, not lobby)
      const syncedRoomEvent = createRoomEvents.find(
        (e: any) =>
          e.event.extensions?.["space.roomy.extension.discordOrigin.v0"],
      );
      expect(syncedRoomEvent).toBeDefined();
      const syncedRoomId = syncedRoomEvent.event.id;
      const sidebarEvent = updateSidebarEvents([
        { name: "Test", children: [syncedRoomId] },
      ]);
      await result.connectedSpace.sendEvent(sidebarEvent);
      await new Promise((resolve) => setTimeout(resolve, 500));

      await bridge.handleRoomyUpdateSidebar(
        {
          idx: 1 as StreamIndex,
          event: sidebarEvent,
          user: "did:plc:test" as any,
        },
        bot,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Channel count should not have changed
      const channelsAfter = await bot.rest.getChannels(TEST_GUILD_ID);
      expect(channelsAfter.size).toBe(countBefore);
    }, 60000); // Increased timeout due to event stream fetches (slow when run with other tests)

    it.skip("should create Discord categories matching Roomy sidebar structure", async () => {
      // TODO: Discord category creation is complex (type 4 channels, rename requires delete/recreate/move)
      // This is out of scope for the current implementation
      expect(true).toBe(true);
    });

    it("should handle channel renames (best-effort)", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const testId = Date.now().toString();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Rename Test - ${testId}`,
      );
      const orchestrator = createBridgeForTest(result, bot);

      const { createRoom, updateSidebarEvents } = await import("@roomy/sdk");

      // Create initial room
      const uniqueName = `original-name-${testId}`;
      const roomEvents = createRoom({
        kind: "space.roomy.channel",
        name: uniqueName,
      });

      for (const event of roomEvents) {
        await result.connectedSpace.sendEvent(event);
      }

      const roomResult = { id: roomEvents[0].id };

      const sidebarEvent = updateSidebarEvents([
        { name: "Test", children: [roomResult.id] },
      ]);
      await result.connectedSpace.sendEvent(sidebarEvent);
      await new Promise((resolve) => setTimeout(resolve, 500));

      await bridge.handleRoomyUpdateSidebar(
        { idx: 1, event: sidebarEvent, user: "did:plc:test" as any },
        bot,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Find the created channel
      const channels1 = await bot.rest.getChannels(TEST_GUILD_ID);
      const synced = [...channels1.values()].find(
        (ch) => ch.name === uniqueName,
      );
      expect(synced).toBeDefined();
      const channelId = synced!.id;

      // Directly test the rename functionality
      await bridge.handleRoomyRoomRename(
        roomResult.id,
        `renamed-channel-${testId}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify the channel was renamed
      const channels2 = await bot.rest.getChannels(TEST_GUILD_ID);
      const renamed = [...channels2.values()].find((ch) => ch.id === channelId);
      expect(renamed).toBeDefined();
      expect(renamed?.name).toBe(`renamed-channel-${testId}`);
    }, 45000); // Increased timeout for rename test (creates channel, syncs, renames)

    it.skip("should handle category renames (best-effort)", async () => {
      // TODO: Discord category rename is complex (requires delete/recreate/move)
      // This is out of scope for the current implementation
      expect(true).toBe(true);
    });

    it("should be idempotent - re-sync does not duplicate Discord channels", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reverse Idempotency Test - ${Date.now()}`,
      );
      const orchestrator = createBridgeForTest(result, bot);

      const { createRoom, updateSidebarEvents } = await import("@roomy/sdk");

      const roomEvents = createRoom({
        kind: "space.roomy.channel",
        name: "test-idempotent-channel",
      });

      for (const event of roomEvents) {
        await result.connectedSpace.sendEvent(event);
      }

      const roomResult = { id: roomEvents[0].id };

      const sidebarEvent = updateSidebarEvents([
        { name: "Test", children: [roomResult.id] },
      ]);
      await result.connectedSpace.sendEvent(sidebarEvent);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // First sync
      await bridge.handleRoomyUpdateSidebar(
        {
          idx: 1 as StreamIndex,
          event: sidebarEvent,
          user: "did:plc:test" as any,
        },
        bot,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Get channel count after first sync
      const channels1 = await bot.rest.getChannels(TEST_GUILD_ID);
      const count1 = channels1.size;

      // Second sync with same sidebar
      await bridge.handleRoomyUpdateSidebar(
        {
          idx: 2 as StreamIndex,
          event: sidebarEvent,
          user: "did:plc:test" as any,
        },
        bot,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Channel count should not have changed
      const channels2 = await bot.rest.getChannels(TEST_GUILD_ID);
      expect(channels2.size).toBe(count1);
    }, 30000);

    it("should store Roomy sync marker in Discord channel topic", async () => {
      // Setup: Create a Roomy room and sync to Discord
      // Expected: Discord channel topic contains Roomy ULID marker
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const testId = Date.now().toString();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Topic Marker Test - ${testId}`,
      );

      const orchestrator = createBridgeForTest(result, bot);

      // 1. Create a Roomy room (without discordOrigin - simulating a room created in Roomy)
      const { createRoom, updateSidebarEvents } = await import("@roomy/sdk");

      const roomEvents = createRoom({
        kind: "space.roomy.channel",
        name: `test-topic-marker-${testId}`,
        description: "A test channel created in Roomy",
      });

      for (const event of roomEvents) {
        await result.connectedSpace.sendEvent(event);
      }

      const roomResult = { id: roomEvents[0].id };

      const roomyRoomId = roomResult.id;

      // 2. Update sidebar to include the new room (triggers sync)
      const sidebarEvent = updateSidebarEvents([
        {
          name: "Test Category",
          children: [roomyRoomId],
        },
      ]);

      await result.connectedSpace.sendEvent(sidebarEvent);

      // Wait for event to be materialized
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 3. Trigger Roomy → Discord sync
      // Wrap event in DecodedStreamEvent format
      const decodedEvent = {
        idx: 1,
        event: sidebarEvent,
        user: "did:plc:test" as any,
      };

      await bridge.handleRoomyUpdateSidebar(decodedEvent, bot);

      // Wait for Discord channel creation
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 4. Get the Discord channel and verify topic contains sync marker
      const discordChannels = await bot.rest.getChannels(TEST_GUILD_ID);
      const syncedChannel = [...discordChannels.values()].find((ch) =>
        ch.topic?.includes(roomyRoomId),
      );

      expect(syncedChannel).toBeDefined();
      expect(syncedChannel?.topic).toContain(
        `[Synced from Roomy: ${roomyRoomId}]`,
      );
    }, 30000);

    it("should recover mapping from channel topic on restart", async () => {
      // Setup: Simulate bridge restart with lost local data
      // Expected: Mapping recovered from Discord channel topics
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const testId = Date.now().toString();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Recovery Test - ${testId}`,
      );

      const orchestrator = createBridgeForTest(result, bot);

      // Phase 1: Create a Roomy room and sync to Discord
      const { createRoom, updateSidebarEvents } = await import("@roomy/sdk");

      const uniqueName = `test-recovery-channel-${testId}`;
      const roomEvents = createRoom({
        kind: "space.roomy.channel",
        name: uniqueName,
        description: "A test channel for recovery testing",
      });

      for (const event of roomEvents) {
        await result.connectedSpace.sendEvent(event);
      }

      const roomyRoomId = roomEvents[0].id;

      // Update sidebar to include the new room
      const sidebarEvent = updateSidebarEvents([
        {
          name: "Recovery Category",
          children: [roomyRoomId],
        },
      ]);

      await result.connectedSpace.sendEvent(sidebarEvent);

      // Wait for event to be materialized
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Trigger Roomy → Discord sync (creates channel with topic marker)
      // Wrap event in DecodedStreamEvent format
      const decodedEvent = {
        idx: 1,
        event: sidebarEvent,
        user: "did:plc:test" as any,
      };

      await bridge.handleRoomyUpdateSidebar(decodedEvent, bot);

      // Wait for Discord channel creation
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify the channel was created and has the topic marker
      const channelsBeforeClear = await bot.rest.getChannels(TEST_GUILD_ID);
      const syncedChannel = [...channelsBeforeClear.values()].find((ch) =>
        ch.topic?.includes(roomyRoomId),
      );
      expect(syncedChannel).toBeDefined();
      expect(syncedChannel?.name).toBe(uniqueName);
      const discordChannelId = syncedChannel!.id.toString();

      // Verify the mapping exists before clearing
      const roomKey = `room:${discordChannelId}`;
      const mappingBefore =
        await result.guildContext.syncedIds.get_discordId(roomKey);
      expect(mappingBefore).toBe(roomyRoomId);

      // Phase 2: Simulate restart - clear syncedIds (simulating data loss)
      await result.guildContext.syncedIds.clear();

      // Verify mapping is gone
      const mappingAfterClear =
        await result.guildContext.syncedIds.get_discordId(roomKey);
      expect(mappingAfterClear).toBeUndefined();

      // Call recovery function to rebuild mappings from Discord topics
      await bridge.recoverMappings();

      // Wait a bit for recovery to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Phase 3: Verify the mapping was recovered
      const mappingAfterRecovery =
        await result.guildContext.syncedIds.get_discordId(roomKey);
      expect(mappingAfterRecovery).toBe(roomyRoomId);

      // Also verify we can look up Discord ID from Roomy ID
      const recoveredDiscordId =
        await result.guildContext.syncedIds.get_roomyId(roomyRoomId);
      expect(recoveredDiscordId).toBe(roomKey);
    }, 30000);

    it("should sync Roomy-native lobby room to Discord on initial backfill", async () => {
      // This test verifies that the default 'lobby' room (which has no discordOrigin)
      // is synced to Discord as a new channel during the initial backfill
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const testId = Date.now().toString();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Lobby Backfill Test - ${testId}`,
      );
      const orchestrator = createBridgeForTest(result, bot);

      // Wait for the default space structure to be created
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Fetch all createRoom events to find the lobby room (no discordOrigin)
      const allEvents = await result.connectedSpace.fetchEvents(1 as any, 100);
      const createRoomEvents = allEvents.filter(
        (e: any) => e.event.$type === "space.roomy.room.createRoom.v0",
      );

      // Find a Roomy-native room (like 'lobby') without discordOrigin
      const lobbyRoomEvent = createRoomEvents.find(
        (e: any) =>
          !e.event.extensions?.["space.roomy.extension.discordOrigin.v0"] &&
          e.event.kind === "space.roomy.channel",
      );

      expect(lobbyRoomEvent).toBeDefined();
      const lobbyRoomId = lobbyRoomEvent!.event.id;
      const lobbyRoomName = lobbyRoomEvent!.event.name;

      console.log(`Found Roomy-native room: ${lobbyRoomName} (${lobbyRoomId})`);

      // Get the current sidebar (it should include the lobby room)
      const sidebarEvents = allEvents.filter(
        (e: any) => e.event.$type === "space.roomy.space.updateSidebar.v0" ||
          e.event.$type === "space.roomy.space.updateSidebar.v1",
      );

      expect(sidebarEvents.length).toBeGreaterThan(0);

      // Trigger Roomy → Discord sync for the sidebar
      const latestSidebarEvent = sidebarEvents[sidebarEvents.length - 1];
      await bridge.handleRoomyUpdateSidebar(
        {
          idx: 1,
          event: latestSidebarEvent.event,
          user: "did:plc:test" as any,
        },
        bot,
      );

      // Wait for Discord channel creation
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify the lobby room was synced to Discord as a new channel
      const discordChannels = await bot.rest.getChannels(TEST_GUILD_ID);
      const syncedChannel = [...discordChannels.values()].find((ch) =>
        ch.topic?.includes(lobbyRoomId),
      );

      expect(syncedChannel).toBeDefined();
      expect(syncedChannel?.topic).toContain(
        `[Synced from Roomy: ${lobbyRoomId}]`,
      );

      console.log(
        `Lobby room "${lobbyRoomName}" synced to Discord as channel "${syncedChannel?.name}"`,
      );
    }, 45000);

    it("should backfill Roomy-native rooms with messages to Discord", async () => {
      // This test validates the full 4-phase backfill process:
      // Phase 0: Fetch sidebar and trigger room creation
      // Phase 1: Fetch Roomy-origin events
      // Phase 2: Backfill Discord messages (empty for Roomy-native rooms)
      // Phase 3: Sync Roomy events with duplicate detection

      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();
      const testId = Date.now().toString();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Full Backfill Test - ${testId}`,
      );
      const orchestrator = createBridgeForTest(result, bot);

      // Wait for default space initialization
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Import updateSidebarEvents
      const { updateSidebarEvents } = await import("@roomy/sdk");

      // Create a Roomy-native room using the Roomy SDK
      const testRoomName = `Backfill Test Room ${testId}`;
      const roomEvents = createRoom({
        kind: "space.roomy.channel",
        name: testRoomName,
        description: "Roomy-native room for backfill testing",
      });

      for (const event of roomEvents) {
        await result.connectedSpace.sendEvent(event);
      }

      const testRoomId = { id: roomEvents[0].id };

      console.log(
        `Created Roomy-native room: ${testRoomName} (${testRoomId.id})`,
      );

      // Add the test room to the sidebar so it will be synced to Discord during backfill
      const sidebarEvent = updateSidebarEvents([
        { name: "Test", children: [testRoomId.id] },
      ]);
      await result.connectedSpace.sendEvent(sidebarEvent);

      console.log(`Added test room to sidebar`);

      // Create some Roomy messages in the room
      const message1Id = await createMessage(result.connectedSpace, {
        roomId: testRoomId.id,
        body: "First message from Roomy",
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const message2Id = await createMessage(result.connectedSpace, {
        roomId: testRoomId.id,
        body: "Second message from Roomy",
      });

      console.log(`Created Roomy messages: ${message1Id.id}, ${message2Id.id}`);

      // Trigger Phase 0: Backfill sidebar to create the Discord channel
      await bridge.backfillRoomyToDiscord(bot);

      // Wait for Phase 0 to complete (channel creation)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify Phase 0: Discord channel was created with Roomy sync marker
      const discordChannels = await bot.rest.getChannels(TEST_GUILD_ID);
      const syncedChannel = [...discordChannels.values()].find((ch) =>
        ch.topic?.includes(testRoomId.id),
      );

      expect(syncedChannel).toBeDefined();
      expect(syncedChannel?.name).toBe(
        testRoomName.toLowerCase().replace(/\s+/g, "-"),
      );
      expect(syncedChannel?.topic).toContain(
        `[Synced from Roomy: ${testRoomId.id}]`,
      );

      console.log(
        `Phase 0 complete: Room synced to Discord as channel "${syncedChannel?.name}"`,
      );

      // Verify Phase 1-3: Messages were backfilled
      const discordMessages = await bot.rest.getMessages(syncedChannel!.id, {
        limit: 10,
      });

      // Should have both Roomy messages in Discord
      expect(discordMessages.length).toBeGreaterThanOrEqual(2);

      const messageContents = discordMessages.map((m) => m.content);

      expect(
        messageContents.some((c) => c?.includes("First message from Roomy")),
      ).toBe(true);
      expect(
        messageContents.some((c) => c?.includes("Second message from Roomy")),
      ).toBe(true);

      console.log(
        `Phase 1-3 complete: ${discordMessages.length} messages backfilled to Discord`,
      );

      // Verify the Roomy room ID is properly tracked in synced IDs
      const syncedDiscordId = await result.guildContext.syncedIds.get_discordId(
        testRoomId.id,
      );

      expect(syncedDiscordId).toBe(syncedChannel!.id);

      console.log("Full backfill validation complete!");
    }, 60000);

    it.skip("should sync both space.roomy.channel and space.roomy.thread kinds", async () => {
      // TODO: Thread sync is future work - Discord thread creation requires different API
      // and handling of parent channel relationships
      expect(true).toBe(true);
    });
  });
});
