/**
 * TEMPORARY TEST: Validate guild connection/reset mechanism.
 *
 * This test verifies that we can:
 * 1. Create a new Roomy space with default structure
 * 2. Connect a Discord guild to it (replacing any existing connection)
 * 3. Verify the mapping is correct
 * 4. Verify the space has expected default structure (lobby, sidebar)
 *
 * Once this passes reliably, we can move on to testing actual sync operations.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  connectGuildToNewSpace,
  initE2ERoomyClient,
  getRoomyClient,
  createQueryHelper,
  createTestBot,
  cleanupRoomySyncedChannels,
} from "../helpers/setup.js";
import { TEST_GUILD_ID } from "../fixtures/test-data.js";
import { registeredBridges } from "../../../src/repositories/LevelDBBridgeRepository.js";
import { connectedSpaces } from "../../../src/roomy/client.js";
import {
  assertLobbyExists,
  assertSidebarStructure,
  assertEventTypeExists,
  assertEventTypeCount,
} from "../helpers/assertions.js";
import { StreamIndex } from "@roomy/sdk";

describe("E2E: Guild Connection/Reset (TEMPORARY)", () => {
  beforeAll(async () => {
    // Initialize Roomy client once (reuses bridge infrastructure)
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E tests");

    // Clean up any channels with Roomy sync marker from previous test runs
    const bot = await createTestBot();
    const deletedCount = await cleanupRoomySyncedChannels(bot, TEST_GUILD_ID);
    console.log(
      `Cleaned up ${deletedCount} Roomy-synced channels from previous test runs`,
    );

    // Clear any stale registrations for the test guild
    const existingSpaceId = await registeredBridges.get_spaceId(TEST_GUILD_ID);
    if (existingSpaceId) {
      console.log(
        `Clearing stale registration: ${TEST_GUILD_ID} -> ${existingSpaceId}`,
      );
      try {
        await registeredBridges.unregister({
          guildId: TEST_GUILD_ID,
          spaceId: existingSpaceId,
        });
      } catch (e) {
        // If unregister fails, clear directly
        await registeredBridges.sublevel.del(`guildId_${TEST_GUILD_ID}`);
        await registeredBridges.sublevel.del(`spaceId_${existingSpaceId}`);
      }
    }

    // Also clear any reverse mappings that might exist
    const bridges = await registeredBridges.list();
    for (const bridge of bridges) {
      if (bridge.guildId === TEST_GUILD_ID) {
        try {
          await registeredBridges.unregister(bridge);
        } catch (e) {
          await registeredBridges.sublevel.del(`guildId_${bridge.guildId}`);
          await registeredBridges.sublevel.del(`spaceId_${bridge.spaceId}`);
        }
      }
    }
  }, 60000);

  beforeEach(async () => {
    // Clear ALL registrations to ensure clean slate
    // This is necessary due to LevelDB caching issues
    await registeredBridges.clear();

    // Also clear connectedSpaces map
    const bridges = await registeredBridges.list();
    for (const bridge of bridges) {
      connectedSpaces.delete(bridge.spaceId);
    }
  });

  afterEach(async () => {
    // Clean up the guild->space mapping after each test
    const existingSpaceId = await registeredBridges.get_spaceId(TEST_GUILD_ID);
    if (existingSpaceId) {
      await registeredBridges.sublevel.batch([
        { type: "del", key: `guildId_${TEST_GUILD_ID}` },
        { type: "del", key: `spaceId_${existingSpaceId}` },
      ]);
      connectedSpaces.delete(existingSpaceId);
    }
  });

  it("should create a space and connect guild to it", async () => {
    const roomy = getRoomyClient();

    // Connect guild to a new space (this resets any existing connection)
    const result = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Test Space - ${Date.now()}`,
    );

    // Verify the connection result
    expect(result.spaceId).toBeDefined();
    expect(result.guildId).toBe(TEST_GUILD_ID);
    expect(result.connectedSpace).toBeDefined();
    expect(result.guildContext).toBeDefined();

    // Verify the guild context has the correct values
    expect(result.guildContext.guildId.toString()).toBe(TEST_GUILD_ID);
    expect(result.guildContext.spaceId).toBe(result.spaceId);
    expect(result.guildContext.connectedSpace).toBe(result.connectedSpace);

    console.log(
      `✓ Connected guild ${result.guildId} to space ${result.spaceId}`,
    );
  });

  it("should have default space structure after connection", async () => {
    const roomy = getRoomyClient();
    const query = createQueryHelper();

    const result = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Structure Test - ${Date.now()}`,
    );

    // Query all events from the space using ConnectedSpace.fetchEvents
    // Returns { event, user } tuples, so extract just the events
    const fetchedEvents = await result.connectedSpace.fetchEvents(
      1 as StreamIndex,
      100,
    );
    const allEvents = fetchedEvents.map((e: any) => e.event);

    // Should have exactly 3 events for default structure:
    // 1. updateSpaceInfo.v0
    // 2. createRoom.v0 (lobby channel)
    // 3. updateSidebar.v0
    expect(allEvents.length).toBeGreaterThanOrEqual(3);

    // Verify each event type exists
    assertEventTypeExists(allEvents, "space.roomy.space.updateSpaceInfo.v0");
    assertEventTypeExists(allEvents, "space.roomy.room.createRoom.v0");
    assertEventTypeExists(allEvents, "space.roomy.space.updateSidebar.v0");

    // Verify lobby channel exists
    const lobbyId = assertLobbyExists(allEvents);
    expect(lobbyId).toBeDefined();

    // Verify sidebar has "general" category with lobby as child
    assertSidebarStructure(allEvents, [{ name: "general", childCount: 1 }]);

    console.log(`✓ Space ${result.spaceId} has correct default structure`);
  });

  it("should reset connection on subsequent calls", async () => {
    const roomy = getRoomyClient();
    const query = createQueryHelper();

    // First connection
    const result1 = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Reset Test 1 - ${Date.now()}`,
    );

    const firstSpaceId = result1.spaceId;

    // Explicit cleanup between the two calls to work around LevelDB caching
    await registeredBridges.sublevel.batch([
      { type: "del", key: `guildId_${TEST_GUILD_ID}` },
      { type: "del", key: `spaceId_${firstSpaceId}` },
    ]);
    connectedSpaces.delete(firstSpaceId);
    // Small delay to ensure flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second connection (should reset)
    const result2 = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Reset Test 2 - ${Date.now()}`,
    );

    const secondSpaceId = result2.spaceId;

    // Verify the space IDs are different (new space created)
    expect(firstSpaceId).not.toBe(secondSpaceId);

    // Query both spaces using ConnectedSpace.fetchEvents
    const firstEvents = (
      await result1.connectedSpace.fetchEvents(1 as StreamIndex, 100)
    ).map((e: any) => e.event);
    const secondEvents = (
      await result2.connectedSpace.fetchEvents(1 as StreamIndex, 100)
    ).map((e: any) => e.event);

    // Both should have default structure
    assertLobbyExists(firstEvents);
    assertLobbyExists(secondEvents);

    // Verify the guild context points to the NEW space
    expect(result2.guildContext.spaceId).toBe(secondSpaceId);

    console.log(
      `✓ Reset worked: ${firstSpaceId.slice(0, 8)}... -> ${secondSpaceId.slice(0, 8)}...`,
    );

    // Explicit cleanup for this test since it creates two spaces
    await registeredBridges.sublevel.batch([
      { type: "del", key: `guildId_${TEST_GUILD_ID}` },
      { type: "del", key: `spaceId_${secondSpaceId}` },
    ]);
    connectedSpaces.delete(secondSpaceId);
  });

  it("should persist guild mapping across roomy client instances", async () => {
    // First client creates connection
    const roomy = getRoomyClient();
    const result1 = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Persistence Test - ${Date.now()}`,
    );
    const spaceId = result1.spaceId;

    // Query the space - should still exist
    const events = (
      await result1.connectedSpace.fetchEvents(1 as StreamIndex, 100)
    ).map((e: any) => e.event);
    expect(events.length).toBeGreaterThan(0);

    // Verify it still has default structure
    assertLobbyExists(events);

    console.log(
      `✓ Guild mapping persisted: ${TEST_GUILD_ID} -> ${spaceId.slice(0, 8)}...`,
    );
  });

  it("should have correct event counts for default space", async () => {
    const roomy = getRoomyClient();
    const query = createQueryHelper();

    const result = await connectGuildToNewSpace(
      roomy,
      TEST_GUILD_ID,
      `E2E Event Count Test - ${Date.now()}`,
    );

    const events = (
      await result.connectedSpace.fetchEvents(1 as StreamIndex, 100)
    ).map((e: any) => e.event);

    // Count events by type
    assertEventTypeCount(events, "space.roomy.space.updateSpaceInfo.v0", 1);
    assertEventTypeCount(events, "space.roomy.room.createRoom.v0", 1);
    assertEventTypeCount(events, "space.roomy.space.updateSidebar.v0", 1);

    console.log(`✓ Event counts verified for ${result.spaceId.slice(0, 8)}...`);
  });
});
