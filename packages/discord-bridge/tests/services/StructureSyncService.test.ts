/**
 * Tests for StructureSyncService.
 * TDD approach: Write failing test first, then implement.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockBridgeRepository } from "../../src/repositories/MockBridgeRepository.js";
import { StructureSyncService } from "../../src/services/StructureSyncService.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid, type Ulid } from "@roomy/sdk";
import type { DiscordBot } from "../../src/discord/types.js";
import type { ChannelProperties, CategoryProperties } from "../../src/discord/types.js";

// Mock ConnectedSpace
const createMockConnectedSpace = () => ({
  sendEvent: vi.fn(async () => {}),
});

// Mock DiscordBot
const createMockBot = (): DiscordBot => ({
  helpers: {
    createChannel: vi.fn(async () => ({ id: 123n })),
  },
} as any);

describe("StructureSyncService", () => {
  let repo: MockBridgeRepository;
  let service: StructureSyncService;
  let mockSpace: ConnectedSpace;
  const guildId = 123456789n;
  const spaceId = "did:plc:test123";

  beforeEach(() => {
    repo = new MockBridgeRepository();
    repo.reset();
    mockSpace = createMockConnectedSpace() as unknown as ConnectedSpace;
    service = new StructureSyncService(repo, mockSpace, guildId, spaceId);
  });

  describe("handleDiscordChannelCreate", () => {
    it("should create a Roomy room for Discord channel", async () => {
      const discordChannel: ChannelProperties = {
        id: 987654321n,
        name: "general",
        type: 0,
      } as any;

      const roomId = await service.handleDiscordChannelCreate(discordChannel);

      // Verify event was sent
      expect(mockSpace.sendEvent).toHaveBeenCalled();
      const sentEvent = (mockSpace.sendEvent as any).mock.calls[0][0];
      expect(sentEvent.$type).toBe("space.roomy.room.createRoom.v0");
      expect(sentEvent.kind).toBe("space.roomy.channel");
      expect(sentEvent.name).toBe("general");

      // Verify mapping was registered
      expect(await repo.getRoomyId("room:987654321")).toBe(roomId);

      // Verify Discord origin extension
      expect(sentEvent.extensions).toBeDefined();
      expect(
        sentEvent.extensions["space.roomy.extension.discordOrigin.v0"],
      ).toBeDefined();
      const origin = sentEvent.extensions[
        "space.roomy.extension.discordOrigin.v0"
      ] as any;
      expect(origin.snowflake).toBe("987654321");
      expect(origin.guildId).toBe("123456789");
    });

    it("should be idempotent - return existing room if already synced", async () => {
      const discordChannel: ChannelProperties = {
        id: 987654321n,
        name: "general",
        type: 0,
      } as any;

      // First call
      const roomId1 = await service.handleDiscordChannelCreate(discordChannel);

      // Reset mock to track second call
      (mockSpace.sendEvent as any).mockClear();

      // Second call should be idempotent
      const roomId2 = await service.handleDiscordChannelCreate(discordChannel);

      expect(roomId1).toBe(roomId2);
      expect(mockSpace.sendEvent).not.toHaveBeenCalled();
    });

    it("should handle channel with no name", async () => {
      const discordChannel: ChannelProperties = {
        id: 987654321n,
        name: undefined,
        type: 0,
      } as any;

      await service.handleDiscordChannelCreate(discordChannel);

      const sentEvent = (mockSpace.sendEvent as any).mock.calls[0][0];
      // Should still create the room
      expect(sentEvent.$type).toBe("space.roomy.room.createRoom.v0");
    });
  });

  describe("handleDiscordThreadCreate", () => {
    it("should create a Roomy thread with link to parent", async () => {
      const discordThread: ChannelProperties = {
        id: 111222333n,
        name: "thread-name",
        type: 11, // Thread type
        parentId: 987654321n,
      } as any;

      const parentChannelId = 987654321n;

      // Set up parent channel mapping
      const parentRoomyId = "parent-room-123";
      await repo.registerMapping(`room:${parentChannelId.toString()}`, parentRoomyId);

      const threadId = await service.handleDiscordThreadCreate(
        discordThread,
        parentChannelId,
      );

      // Should have sent two events: createRoom and createRoomLink
      expect(mockSpace.sendEvent).toHaveBeenCalledTimes(2);

      const createEvent = (mockSpace.sendEvent as any).mock.calls[0][0];
      expect(createEvent.$type).toBe("space.roomy.room.createRoom.v0");
      expect(createEvent.kind).toBe("space.roomy.thread");
      expect(createEvent.name).toBe("thread-name");

      const linkEvent = (mockSpace.sendEvent as any).mock.calls[1][0];
      expect(linkEvent.$type).toBe("space.roomy.link.createRoomLink.v0");
      expect(linkEvent.room).toBe(parentRoomyId);
      expect(linkEvent.linkToRoom).toBe(threadId);

      // Verify thread mapping was registered
      expect(await repo.getRoomyId("room:111222333")).toBe(threadId);

      // Verify link mapping was registered
      const linkKey = `${parentRoomyId}:${threadId}`;
      expect(await repo.getRoomLink(linkKey)).toBeDefined();
    });

    it("should throw if parent channel not synced", async () => {
      const discordThread: ChannelProperties = {
        id: 111222333n,
        name: "thread-name",
        type: 11,
        parentId: 987654321n,
      } as any;

      const parentChannelId = 987654321n;

      // Parent not registered

      await expect(
        service.handleDiscordThreadCreate(discordThread, parentChannelId),
      ).rejects.toThrow("Parent channel");
    });

    it("should be idempotent - return existing thread if already synced", async () => {
      const discordThread: ChannelProperties = {
        id: 111222333n,
        name: "thread-name",
        type: 11,
        parentId: 987654321n,
      } as any;

      const parentChannelId = 987654321n;
      const parentRoomyId = "parent-room-123";
      await repo.registerMapping(`room:${parentChannelId.toString()}`, parentRoomyId);

      // First call
      const threadId1 = await service.handleDiscordThreadCreate(
        discordThread,
        parentChannelId,
      );

      // Reset mock
      (mockSpace.sendEvent as any).mockClear();

      // Second call should be idempotent
      const threadId2 = await service.handleDiscordThreadCreate(
        discordThread,
        parentChannelId,
      );

      expect(threadId1).toBe(threadId2);
      expect(mockSpace.sendEvent).not.toHaveBeenCalled();
    });
  });

  describe("syncFullDiscordSidebar", () => {
    it("should sync sidebar with hash-based idempotency", async () => {
      const channels: ChannelProperties[] = [
        { id: 111n, name: "general", type: 0, parentId: null } as any,
        { id: 222n, name: "random", type: 0, parentId: null } as any,
      ];

      const categories: CategoryProperties[] = [];

      // Set up channel mappings
      await repo.registerMapping("room:111", "roomy-111");
      await repo.registerMapping("room:222", "roomy-222");

      await service.syncFullDiscordSidebar(channels, categories);

      // Verify sidebar update event was sent
      expect(mockSpace.sendEvent).toHaveBeenCalled();
      const sentEvent = (mockSpace.sendEvent as any).mock.calls[0][0];
      expect(sentEvent.$type).toBe("space.roomy.space.updateSidebar.v0");

      // Verify hash was stored
      const storedHash = await repo.getSidebarHash();
      expect(storedHash).toBeDefined();
    });

    it("should skip if sidebar hash unchanged", async () => {
      const channels: ChannelProperties[] = [
        { id: 111n, name: "general", type: 0, parentId: null } as any,
      ];

      const categories: CategoryProperties[] = [];

      await repo.registerMapping("room:111", "roomy-111");

      // First sync
      await service.syncFullDiscordSidebar(channels, categories);
      const firstHash = await repo.getSidebarHash();

      // Reset mock
      (mockSpace.sendEvent as any).mockClear();

      // Second sync with same data should skip
      await service.syncFullDiscordSidebar(channels, categories);

      expect(mockSpace.sendEvent).not.toHaveBeenCalled();
      expect(await repo.getSidebarHash()).toBe(firstHash);
    });

    it("should resync if sidebar hash changed", async () => {
      const channels1: ChannelProperties[] = [
        { id: 111n, name: "general", type: 0, parentId: null } as any,
      ];

      const channels2: ChannelProperties[] = [
        { id: 111n, name: "general", type: 0, parentId: null } as any,
        { id: 222n, name: "random", type: 0, parentId: null } as any, // Added new channel
      ];

      const categories: CategoryProperties[] = [];

      await repo.registerMapping("room:111", "roomy-111");
      await repo.registerMapping("room:222", "roomy-222");

      // First sync
      await service.syncFullDiscordSidebar(channels1, categories);

      // Reset mock
      (mockSpace.sendEvent as any).mockClear();

      // Second sync with different structure should trigger update
      await service.syncFullDiscordSidebar(channels2, categories);

      expect(mockSpace.sendEvent).toHaveBeenCalled();
    });

    it("should build correct category structure", async () => {
      const channels: ChannelProperties[] = [
        { id: 111n, name: "general", type: 0, parentId: 100n } as any,
        { id: 222n, name: "random", type: 0, parentId: 100n } as any,
        { id: 333n, name: "uncategorized", type: 0, parentId: null } as any,
      ];

      const categories: CategoryProperties[] = [
        { id: 100n, name: "My Category", type: 4 } as any,
      ];

      await repo.registerMapping("room:111", "roomy-111");
      await repo.registerMapping("room:222", "roomy-222");
      await repo.registerMapping("room:333", "roomy-333");

      await service.syncFullDiscordSidebar(channels, categories);

      const sentEvent = (mockSpace.sendEvent as any).mock.calls[0][0];

      // Should have categories with children
      expect(Array.isArray(sentEvent.categories)).toBe(true);
    });
  });

  describe("handleRoomyRoomCreate (stub)", () => {
    it("should throw not implemented error", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.room.createRoom.v0",
      } as any;

      await expect(service.handleRoomyRoomCreate(event)).rejects.toThrow(
        "Not implemented",
      );
    });
  });

  describe("handleRoomySidebarUpdate (stub)", () => {
    it("should throw not implemented error", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.space.updateSidebar.v0",
      } as any;

      await expect(service.handleRoomySidebarUpdate(event)).rejects.toThrow(
        "Not implemented",
      );
    });
  });
});
