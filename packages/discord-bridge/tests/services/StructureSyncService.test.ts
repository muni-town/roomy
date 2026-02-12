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
import type { ChannelProperties } from "../../src/discord/types.js";
import { DISCORD_EXTENSION_KEYS } from "../../src/utils/event-extensions.js";

// Mock ConnectedSpace
const createMockConnectedSpace = () => ({
  sendEvent: vi.fn(async () => {}),
});

// Mock DiscordBot
const createMockBot = (): DiscordBot =>
  ({
    helpers: {
      createChannel: vi.fn(async () => ({ id: 123n })),
    },
  }) as any;

describe("StructureSyncService", () => {
  let repo: MockBridgeRepository;
  let service: StructureSyncService;
  let mockSpace: ConnectedSpace;
  let mockBot: DiscordBot;
  const guildId = 123456789n;
  const spaceId = "did:plc:test123";

  beforeEach(() => {
    repo = new MockBridgeRepository();
    repo.reset();
    mockBot = createMockBot();
    mockSpace = createMockConnectedSpace() as unknown as ConnectedSpace;
    service = new StructureSyncService(repo, mockSpace, guildId, mockBot);
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
      await repo.registerMapping(
        `room:${parentChannelId.toString()}`,
        parentRoomyId,
      );

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
      await repo.registerMapping(
        `room:${parentChannelId.toString()}`,
        parentRoomyId,
      );

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
    beforeEach(() => {
      // Mock fetchEvents for sidebar sync tests
      (mockSpace as any).fetchEvents = vi.fn(async () => []);
    });

    it("should sync sidebar with hash-based idempotency", async () => {
      const channels: ChannelProperties[] = [
        { id: 111n, name: "general", type: 0, parentId: null } as any,
        { id: 222n, name: "random", type: 0, parentId: null } as any,
      ];

      const categories: ChannelProperties[] = [];

      // Set up channel mappings
      await repo.registerMapping("room:111", "roomy-111");
      await repo.registerMapping("room:222", "roomy-222");

      await service.syncFullDiscordSidebar(channels, categories);

      // Verify sidebar update event was sent
      expect(mockSpace.sendEvent).toHaveBeenCalled();
      const sentEvent = (mockSpace.sendEvent as any).mock.calls[0][0];
      expect(sentEvent.$type).toBe("space.roomy.space.updateSidebar.v1");

      // Verify hash was stored
      const storedHash = await repo.getSidebarHash();
      expect(storedHash).toBeDefined();
    });

    it("should skip if sidebar hash unchanged", async () => {
      const channels: ChannelProperties[] = [
        { id: 111n, name: "general", type: 0, parentId: null } as any,
      ];

      const categories: ChannelProperties[] = [];

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

      const categories: ChannelProperties[] = [];

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

      const categories: ChannelProperties[] = [
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

  describe("handleRoomyRoomCreate", () => {
    it("should skip rooms with discordOrigin extension", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const event = {
        id: newUlid(),
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.channel",
        name: "test-channel",
        extensions: {
          [DISCORD_EXTENSION_KEYS.ROOM_ORIGIN]: {
            $type: DISCORD_EXTENSION_KEYS.ROOM_ORIGIN,
            snowflake: "123456",
            guildId: guildId.toString(),
          },
        },
      } as any;

      await serviceWithBot.handleRoomyRoomCreate(event);

      // Should not have created any channel
      expect(bot.helpers.createChannel).not.toHaveBeenCalled();
    });

    it("should create Discord channel for Roomy room without discordOrigin", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      // Mock fetchEvents to return our room event
      (mockSpace as any).fetchEvents = vi.fn(async () => []);

      const event = {
        id: newUlid(),
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.channel",
        name: "test-roomy-channel",
        extensions: {},
      } as any;

      await serviceWithBot.handleRoomyRoomCreate(event);

      // Should have created Discord channel
      expect(bot.helpers.createChannel).toHaveBeenCalled();
    });

    it("should skip non-channel room kinds", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const event = {
        id: newUlid(),
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.page", // Not a channel
        name: "test-page",
        extensions: {},
      } as any;

      await serviceWithBot.handleRoomyRoomCreate(event);

      // Should not have created any channel
      expect(bot.helpers.createChannel).not.toHaveBeenCalled();
    });
  });

  describe("handleRoomySidebarUpdate", () => {
    it("should skip rooms with discordOrigin extension", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const roomyRoomId = newUlid();

      // Mock fetchEvents to return room with discordOrigin
      (mockSpace as any).fetchEvents = vi.fn(async () => [
        {
          event: {
            id: roomyRoomId,
            $type: "space.roomy.room.createRoom.v0",
            name: "test-channel",
            extensions: {
              [DISCORD_EXTENSION_KEYS.ROOM_ORIGIN]: {
                $type: DISCORD_EXTENSION_KEYS.ROOM_ORIGIN,
                snowflake: "123456",
                guildId: guildId.toString(),
              },
            },
          },
        },
      ]);

      const sidebarEvent = {
        id: newUlid(),
        $type: "space.roomy.space.updateSidebar.v0",
        categories: [{ name: "Test", children: [roomyRoomId] }],
      } as any;

      await serviceWithBot.handleRoomySidebarUpdate(sidebarEvent);

      // Should not have created any channel
      expect(bot.helpers.createChannel).not.toHaveBeenCalled();
    });

    it("should create Discord channels for rooms without discordOrigin", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const roomyRoomId = newUlid();

      // Mock fetchEvents to return room without discordOrigin
      (mockSpace as any).fetchEvents = vi.fn(async () => [
        {
          event: {
            id: roomyRoomId,
            $type: "space.roomy.room.createRoom.v0",
            name: "test-roomy-channel",
            extensions: {},
          },
        },
      ]);

      const sidebarEvent = {
        id: newUlid(),
        $type: "space.roomy.space.updateSidebar.v0",
        categories: [{ name: "Test", children: [roomyRoomId] }],
      } as any;

      await serviceWithBot.handleRoomySidebarUpdate(sidebarEvent);

      // Should have created Discord channel
      expect(bot.helpers.createChannel).toHaveBeenCalled();
    });

    it("should handle empty sidebar gracefully", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const sidebarEvent = {
        id: newUlid(),
        $type: "space.roomy.space.updateSidebar.v0",
        categories: [],
      } as any;

      await serviceWithBot.handleRoomySidebarUpdate(sidebarEvent);

      // Should not have created any channel
      expect(bot.helpers.createChannel).not.toHaveBeenCalled();
    });
  });

  describe("handleRoomyEvent", () => {
    it("should register Discord room origin mapping and skip sync", async () => {
      const discordChannelId = "123";
      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.room.createRoom.v0",
          id: newUlid(),
          name: "general",
          extensions: {
            "space.roomy.extension.discordOrigin.v0": {
              snowflake: discordChannelId,
              guildId: guildId.toString(),
            },
          },
        },
        user: "did:discord:123" as any,
      } as any;

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(true);
      // Use getRoomKey format: "room:" prefix
      expect(await repo.getRoomyId(`room:${discordChannelId}`)).toBe(
        event.event.id,
      );
      expect(mockBot?.helpers.createChannel).not.toHaveBeenCalled();
    });

    it("should cache sidebar hash for Discord-origin sidebars", async () => {
      const sidebarHash = "hash123";
      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.space.updateSidebar.v0",
          id: newUlid(),
          categories: [],
          extensions: {
            "space.roomy.extension.discordSidebarOrigin.v0": {
              guildId: guildId.toString(),
              sidebarHash,
            },
          },
        },
        user: "did:discord:123" as any,
      } as any;

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(true);
      const cachedHash = await repo.getSidebarHash();
      expect(cachedHash).toBe(sidebarHash);
    });

    it("should cache room link mappings", async () => {
      const parentRoomyId = "room-123";
      const childRoomyId = "room-456";
      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.link.createRoomLink.v0",
          id: newUlid(),
          room: parentRoomyId,
          linkToRoom: childRoomyId,
          extensions: {
            "space.roomy.extension.discordRoomLinkOrigin.v0": {
              parentSnowflake: "123",
              childSnowflake: "456",
              guildId: guildId.toString(),
            },
          },
        },
        user: "did:discord:123" as any,
      } as any;

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(true);
      const linkKey = `${parentRoomyId}:${childRoomyId}`;
      expect(await repo.getRoomLink(linkKey)).toBe(event.event.id);
    });

    it("should unregister room mapping on delete", async () => {
      const roomId = "room-123";
      const discordId = "room:456";
      await repo.registerMapping(discordId, roomId);

      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.room.deleteRoom.v0",
          id: newUlid(),
          roomId,
        },
        user: "did:alice:123" as any,
      } as any;

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(true);
      expect(await repo.getDiscordId(roomId)).toBeUndefined();
    });

    it("should log warning for Roomy room deletion (not yet implemented)", async () => {
      const roomId = "room-123";

      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.room.deleteRoom.v0",
          id: newUlid(),
          roomId,
        },
        user: "did:alice:123" as any,
      } as any;

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(true);
      // When room is not synced, it logs "not synced to Discord, skipping delete"
      // To test the "not yet implemented" warning, we'd need to mock getDiscordId
      // For now, just verify it handles the case gracefully
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should return false for unknown event types", async () => {
      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.message.createMessage.v0",
          id: newUlid(),
        },
        user: "did:alice:123" as any,
      } as any;

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(false);
    });

    it("should handle errors gracefully and return false", async () => {
      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.room.deleteRoom.v0",
          id: newUlid(),
          roomId: "room-123",
        },
        user: "did:alice:123" as any,
      } as any;

      vi.spyOn(repo, "getDiscordId").mockRejectedValue(new Error("DB error"));

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(false);
    });

    it("should register mapping but NOT sync Roomy room without discordOrigin", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const event = {
        idx: 1,
        event: {
          id: newUlid(),
          $type: "space.roomy.room.createRoom.v0",
          kind: "space.roomy.channel",
          name: "test-roomy-channel",
          extensions: {}, // No Discord origin
        },
        user: "did:alice:123",
      } as any;

      const result = await serviceWithBot.handleRoomyEvent(event);

      expect(result).toBe(true); // Event was handled
      expect(bot.helpers.createChannel).not.toHaveBeenCalled(); // But no channel created
    });

    it("should sync Roomy room when it appears in updateSidebar", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const roomyRoomId = newUlid();

      // Mock fetchEvents to return room without discordOrigin
      (mockSpace as any).fetchEvents = vi.fn(async () => [
        {
          event: {
            id: roomyRoomId,
            $type: "space.roomy.room.createRoom.v0",
            name: "test-roomy-channel",
            kind: "space.roomy.channel",
            extensions: {},
          },
        },
      ]);

      const sidebarEvent = {
        idx: 1,
        event: {
          id: newUlid(),
          $type: "space.roomy.space.updateSidebar.v0",
          categories: [{ name: "Test", children: [roomyRoomId] }],
          extensions: {}, // No Discord origin
        },
        user: "did:alice:123",
      } as any;

      await serviceWithBot.handleRoomyEvent(sidebarEvent);

      // Should have created Discord channel
      expect(bot.helpers.createChannel).toHaveBeenCalled();
    });

    it("should sync Roomy thread when isCreationLink is true", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const parentRoomyId = newUlid();
      const threadRoomyId = newUlid();

      // Set up parent Discord mapping
      await repo.registerMapping("room:123", parentRoomyId);

      // Mock fetchEvents to return thread name
      (mockSpace as any).fetchEvents = vi.fn(async () => [
        {
          event: {
            id: threadRoomyId,
            $type: "space.roomy.room.createRoom.v0",
            name: "test-thread",
            kind: "space.roomy.thread",
            extensions: {},
          },
        },
      ]);

      const linkEvent = {
        idx: 1,
        event: {
          id: newUlid(),
          $type: "space.roomy.link.createRoomLink.v0",
          room: parentRoomyId,
          linkToRoom: threadRoomyId,
          isCreationLink: true,
          extensions: {}, // No Discord origin
        },
        user: "did:alice:123",
      } as any;

      await serviceWithBot.handleRoomyEvent(linkEvent);

      // Should have created Discord thread via bot.helpers.createChannel
      expect(bot.helpers.createChannel).toHaveBeenCalledWith(
        guildId,
        expect.objectContaining({
          name: "test-thread",
          type: 11, // GUILD_PUBLIC_THREAD
          parentId: "123",
        }),
      );
    });

    it("should NOT sync when isCreationLink is false or missing", async () => {
      const bot = createMockBot();
      const serviceWithBot = new StructureSyncService(
        repo,
        mockSpace as unknown as ConnectedSpace,
        guildId,
        bot,
      );

      const linkEvent = {
        idx: 1,
        event: {
          id: newUlid(),
          $type: "space.roomy.link.createRoomLink.v0",
          room: "parent-123",
          linkToRoom: "child-456",
          isCreationLink: false, // or undefined
          extensions: {},
        },
        user: "did:alice:123",
      } as any;

      await serviceWithBot.handleRoomyEvent(linkEvent);

      expect(bot.helpers.createChannel).not.toHaveBeenCalled();
    });
  });
});
