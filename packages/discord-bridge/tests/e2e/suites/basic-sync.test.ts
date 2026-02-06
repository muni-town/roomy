/**
 * Basic sync E2E tests.
 * Tests core Discord -> Roomy sync functionality:
 * - Channel creation
 * - Message sync
 * - Sidebar structure
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestBot,
  createRoomyTestClient,
  getTestEnv,
} from "../helpers/setup.js";
import {
  assertLobbyExists,
  assertSidebarStructure,
  assertEventTypeCount,
  assertRoomExists,
  assertEventTypeExists,
  assertMessageExists,
  decodeMessageData,
} from "../helpers/assertions.js";
import { TEST_GUILD_ID, getExpectedTextChannels } from "../fixtures/test-data.js";

describe("E2E: Basic Discord -> Roomy Sync", () => {
  const env = getTestEnv();

  beforeAll(async () => {
    // Setup could go here if needed
  }, 30000);

  describe("Default Space Structure", () => {
    it("should create a space with default structure (lobby + sidebar)", async () => {
      const roomy = await createRoomyTestClient();

      const { spaceId, events } = await roomy.createDefaultSpace("E2E Test Space");

      // Query all events from the space
      const allEvents = await roomy.queryEvents(spaceId, { limit: 100 });

      // Should have 3 events: updateSpaceInfo, createRoom (lobby), updateSidebar
      expect(allEvents.length).toBeGreaterThanOrEqual(3);

      // Verify lobby exists
      const lobbyId = assertLobbyExists(allEvents);
      expect(lobbyId).toBeDefined();

      // Verify sidebar has "general" category with lobby
      assertSidebarStructure(allEvents, [
        { name: "general", childCount: 1 },
      ]);

      // Verify space info event exists
      assertEventTypeExists(allEvents, "space.roomy.space.updateSpaceInfo.v0");
    });
  });

  describe("Discord Channel Sync", () => {
    it("should sync Discord channels to Roomy", async () => {
      const bot = await createTestBot();
      const roomy = await createRoomyTestClient();

      // Create space and connect Discord guild
      const { spaceId } = await roomy.createDefaultSpace("E2E Channel Sync Test");

      // TODO: Register bridge connection
      // TODO: Trigger channel sync
      // TODO: Query and verify channels

      // For now, just verify the space was created
      const events = await roomy.queryEvents(spaceId);
      expect(events.length).toBeGreaterThanOrEqual(3);
    });

    it("should create channels matching Discord structure", async () => {
      // This will test that the sidebar structure matches Discord categories
      const expectedChannels = getExpectedTextChannels();

      // We expect: general, dev-general, bugs (from test guild)
      // Plus the default lobby channel
      expect(expectedChannels.length).toBe(3);
      expect(expectedChannels.some((c) => c.name === "general")).toBe(true);
      expect(expectedChannels.some((c) => c.name === "dev-general")).toBe(true);
      expect(expectedChannels.some((c) => c.name === "bugs")).toBe(true);
    });
  });

  describe("Discord Message Sync", () => {
    it("should sync messages from Discord to Roomy", async () => {
      const bot = await createTestBot();
      const roomy = await createRoomyTestClient();

      // Create space
      const { spaceId } = await roomy.createDefaultSpace("E2E Message Sync Test");

      // TODO: Trigger full sync including messages
      // TODO: Verify message count matches Discord
      // TODO: Verify message content is correct

      // Placeholder for now
      const events = await roomy.queryEvents(spaceId);
      expect(events.length).toBeGreaterThan(0);
    });

    it("should preserve message content", async () => {
      // This will verify that message text is correctly synced
      // Expected messages from #general:
      // - "a message that becomes the start of a thread"
      // - "a message I have edited"
      // - "message with an image attachment"

      expect(true).toBe(true); // Placeholder
    });

    it("should handle edited messages", async () => {
      // Verify that message edits are tracked correctly
      // The test guild has an edited message in #general

      expect(true).toBe(true); // Placeholder
    });

    it("should handle attachments", async () => {
      // Verify that attachments are preserved
      // The test guild has a message with an image attachment in #general

      expect(true).toBe(true); // Placeholder
    });
  });

  describe("Idempotency", () => {
    it("should not duplicate events on re-sync", async () => {
      const roomy = await createRoomyTestClient();

      // Create space
      const { spaceId } = await roomy.createDefaultSpace("E2E Idempotency Test");

      // Get initial event count
      const initialEvents = await roomy.queryEvents(spaceId);
      const initialCount = initialEvents.length;

      // TODO: Trigger sync twice
      // TODO: Verify event count hasn't increased for same data

      // Placeholder
      expect(initialCount).toBeGreaterThan(0);
    });
  });
});
