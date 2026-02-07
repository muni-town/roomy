/**
 * Tests for MessageSyncService.
 * TDD approach: Write failing test first, then implement.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockBridgeRepository } from "../../src/repositories/MockBridgeRepository.js";
import { MessageSyncService } from "../../src/services/MessageSyncService.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid, type Ulid } from "@roomy/sdk";
import type { DiscordBot } from "../../src/discord/types.js";
import type { MessageProperties, Attachment } from "../../src/discord/types.js";
import { ProfileSyncService } from "../../src/services/ProfileSyncService.js";
import { DISCORD_MESSAGE_TYPES } from "../../src/constants.js";

// Mock ConnectedSpace
const createMockConnectedSpace = () => ({
  sendEvent: vi.fn(async () => {}),
});

// Mock DiscordBot
const createMockBot = (): DiscordBot => ({
  helpers: {
    getMessage: vi.fn(async () => null),
    editMessage: vi.fn(async () => ({ id: 456n })),
    deleteMessage: vi.fn(async () => ({ success: true })),
    executeWebhook: vi.fn(async () => ({ id: 123n })),
  },
} as any);

// Mock EventBatcher
const createMockBatcher = () => ({
  add: vi.fn(async () => {}),
});

describe("MessageSyncService", () => {
  let repo: MockBridgeRepository;
  let service: MessageSyncService;
  let profileService: ProfileSyncService;
  let mockSpace: ConnectedSpace;
  let mockBot: DiscordBot;
  const guildId = 123456789n;
  const spaceId = "did:plc:test123";

  beforeEach(() => {
    repo = new MockBridgeRepository();
    repo.reset();
    mockSpace = createMockConnectedSpace() as unknown as ConnectedSpace;
    mockBot = createMockBot();
    profileService = new ProfileSyncService(repo, mockSpace, guildId, spaceId);
    service = new MessageSyncService(
      repo,
      mockSpace,
      guildId,
      spaceId,
      profileService,
      mockBot,
    );
  });

  describe("syncDiscordToRoomy", () => {
    it("should create a Roomy message for Discord message", async () => {
      const roomyRoomId = "target-room-123";
      const discordMessage: MessageProperties = {
        id: 987654321n,
        content: "Hello, world!",
        channelId: 111222333n,
        author: {
          id: 444555666n,
          username: "testuser",
          discriminator: "0001",
          globalName: "Test User",
          avatar: "abc123",
        },
        timestamp: Date.now(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      // Set up channel mapping
      await repo.registerMapping(`room:${discordMessage.channelId.toString()}`, roomyRoomId);

      const result = await service.syncDiscordToRoomy(roomyRoomId, discordMessage);

      // Verify events were sent (profile + message)
      expect(mockSpace.sendEvent).toHaveBeenCalled();
      const calls = (mockSpace.sendEvent as any).mock.calls;
      // Find the message event (second call, after profile event)
      const messageCall = calls.find((call: any) => call[0].$type === "space.roomy.message.createMessage.v0");
      expect(messageCall).toBeDefined();
      const sentEvent = messageCall[0];
      expect(sentEvent.$type).toBe("space.roomy.message.createMessage.v0");
      expect(sentEvent.room).toBe(roomyRoomId);

      // Verify message ID mapping was registered
      expect(await repo.getRoomyId(discordMessage.id.toString())).toBe(result);
    });

    it("should be idempotent - skip if already synced", async () => {
      const roomyRoomId = "target-room-123";
      const discordMessage: MessageProperties = {
        id: 987654321n,
        content: "Hello, world!",
        channelId: 111222333n,
        author: {
          id: 444555666n,
          username: "testuser",
          discriminator: "0001",
          globalName: null,
          avatar: null,
        },
        timestamp: Date.now(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      await repo.registerMapping(`room:${discordMessage.channelId.toString()}`, roomyRoomId);

      // First call
      const result1 = await service.syncDiscordToRoomy(roomyRoomId, discordMessage);

      // Reset mock
      (mockSpace.sendEvent as any).mockClear();

      // Second call should be idempotent
      const result2 = await service.syncDiscordToRoomy(roomyRoomId, discordMessage);

      expect(mockSpace.sendEvent).not.toHaveBeenCalled();
      expect(result1).toBe(result2);
    });

    it("should skip bot's own webhook messages", async () => {
      const roomyRoomId = "target-room-123";
      const webhookId = 999888777n;
      const discordMessage: MessageProperties = {
        id: 987654321n,
        content: "Echo message",
        channelId: 111222333n,
        author: { id: 444555666n, username: "bot", discriminator: "0000", avatar: null },
        timestamp: Date.now(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: webhookId,
      } as any;

      await repo.registerMapping(`room:${discordMessage.channelId.toString()}`, roomyRoomId);
      // Set webhook token (webhookId:token format)
      await repo.setWebhookToken(discordMessage.channelId.toString(), `${webhookId}:token123`);

      const result = await service.syncDiscordToRoomy(roomyRoomId, discordMessage);

      // Should skip
      expect(mockSpace.sendEvent).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should skip system messages (THREAD_CREATED)", async () => {
      const roomyRoomId = "target-room-123";
      const discordMessage: MessageProperties = {
        id: 987654321n,
        content: "Thread created",
        channelId: 111222333n,
        author: { id: 444555666n, username: "system", discriminator: "0000", avatar: null },
        timestamp: Date.now(),
        type: DISCORD_MESSAGE_TYPES.THREAD_CREATED,
        attachments: [],
        webhookId: null,
      } as any;

      await repo.registerMapping(`room:${discordMessage.channelId.toString()}`, roomyRoomId);

      const result = await service.syncDiscordToRoomy(roomyRoomId, discordMessage);

      expect(mockSpace.sendEvent).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should include discordMessageOrigin extension", async () => {
      const roomyRoomId = "target-room-123";
      const discordMessage: MessageProperties = {
        id: 987654321n,
        content: "Hello",
        channelId: 111222333n,
        author: {
          id: 444555666n,
          username: "testuser",
          discriminator: "0001",
          globalName: null,
          avatar: null,
        },
        timestamp: Date.now(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      await repo.registerMapping(`room:${discordMessage.channelId.toString()}`, roomyRoomId);

      await service.syncDiscordToRoomy(roomyRoomId, discordMessage);

      const calls = (mockSpace.sendEvent as any).mock.calls;
      const messageCall = calls.find((call: any) => call[0].$type === "space.roomy.message.createMessage.v0");
      const sentEvent = messageCall[0];
      expect(sentEvent.extensions).toBeDefined();
      expect(
        sentEvent.extensions["space.roomy.extension.discordMessageOrigin.v0"],
      ).toBeDefined();

      const origin = sentEvent.extensions[
        "space.roomy.extension.discordMessageOrigin.v0"
      ] as any;
      expect(origin.snowflake).toBe("987654321");
      expect(origin.channelId).toBe("111222333");
      expect(origin.guildId).toBe("123456789");
    });

    it("should include author override extension", async () => {
      const roomyRoomId = "target-room-123";
      const discordMessage: MessageProperties = {
        id: 987654321n,
        content: "Hello",
        channelId: 111222333n,
        author: {
          id: 444555666n,
          username: "testuser",
          discriminator: "0001",
          globalName: null,
          avatar: null,
        },
        timestamp: Date.now(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      await repo.registerMapping(`room:${discordMessage.channelId.toString()}`, roomyRoomId);

      await service.syncDiscordToRoomy(roomyRoomId, discordMessage);

      const calls = (mockSpace.sendEvent as any).mock.calls;
      const messageCall = calls.find((call: any) => call[0].$type === "space.roomy.message.createMessage.v0");
      const sentEvent = messageCall[0];
      expect(sentEvent.extensions["space.roomy.extension.authorOverride.v0"]).toBeDefined();
      const authorOverride = sentEvent.extensions[
        "space.roomy.extension.authorOverride.v0"
      ] as any;
      expect(authorOverride.did).toBe("did:discord:444555666");
    });

    it("should include timestamp override extension", async () => {
      const roomyRoomId = "target-room-123";
      const timestamp = Date.now();
      const discordMessage: MessageProperties = {
        id: 987654321n,
        content: "Hello",
        channelId: 111222333n,
        author: {
          id: 444555666n,
          username: "testuser",
          discriminator: "0001",
          avatar: null,
        },
        timestamp,
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      await repo.registerMapping(`room:${discordMessage.channelId.toString()}`, roomyRoomId);

      await service.syncDiscordToRoomy(roomyRoomId, discordMessage);

      const calls = (mockSpace.sendEvent as any).mock.calls;
      const messageCall = calls.find((call: any) => call[0].$type === "space.roomy.message.createMessage.v0");
      const sentEvent = messageCall[0];
      expect(sentEvent.extensions["space.roomy.extension.timestampOverride.v0"]).toBeDefined();
      const tsOverride = sentEvent.extensions[
        "space.roomy.extension.timestampOverride.v0"
      ] as any;
      expect(tsOverride.timestamp).toBe(new Date(timestamp).getTime());
    });

    it("should support batcher parameter", async () => {
      const roomyRoomId = "target-room-123";
      const discordMessage: MessageProperties = {
        id: 987654321n,
        content: "Hello",
        channelId: 111222333n,
        author: {
          id: 444555666n,
          username: "testuser",
          discriminator: "0001",
          avatar: null,
        },
        timestamp: Date.now(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      await repo.registerMapping(`room:${discordMessage.channelId.toString()}`, roomyRoomId);
      const mockBatcher = createMockBatcher();

      await service.syncDiscordToRoomy(roomyRoomId, discordMessage, mockBatcher);

      expect(mockBatcher.add).toHaveBeenCalled();
      expect(mockSpace.sendEvent).not.toHaveBeenCalled();
    });
  });

  describe("syncEditToRoomy", () => {
    it("should sync a message edit to Roomy", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const editedMessage: MessageProperties = {
        id: messageId,
        content: "Edited content",
        channelId: channelId,
        author: {
          id: 444555666n,
          username: "testuser",
          discriminator: "0001",
          avatar: null,
        },
        timestamp: Date.now() - 10000,
        editedTimestamp: new Date(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      const roomyRoomId = "target-room-123";
      const roomyMessageId = "roomy-msg-456";

      await repo.registerMapping(messageId.toString(), roomyMessageId);
      await repo.registerMapping(`room:${channelId.toString()}`, roomyRoomId);

      await service.syncEditToRoomy(editedMessage);

      expect(mockSpace.sendEvent).toHaveBeenCalled();
      const sentEvent = (mockSpace.sendEvent as any).mock.calls[0][0];
      expect(sentEvent.$type).toBe("space.roomy.message.editMessage.v0");
      expect(sentEvent.messageId).toBe(roomyMessageId);
    });

    it("should skip if message not synced", async () => {
      const editedMessage: MessageProperties = {
        id: 987654321n,
        content: "Edited content",
        channelId: 111222333n,
        author: { id: 444555666n, username: "testuser", discriminator: "0001", avatar: null },
        timestamp: Date.now() - 10000,
        editedTimestamp: new Date(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      await service.syncEditToRoomy(editedMessage);

      expect(mockSpace.sendEvent).not.toHaveBeenCalled();
    });
  });

  describe("syncDeleteToRoomy", () => {
    it("should sync a message deletion to Roomy", async () => {
      const messageId = 987654321n;
      const roomyMessageId = "roomy-msg-456";

      await repo.registerMapping(messageId.toString(), roomyMessageId);

      await service.syncDeleteToRoomy(messageId);

      expect(mockSpace.sendEvent).toHaveBeenCalled();
      const sentEvent = (mockSpace.sendEvent as any).mock.calls[0][0];
      expect(sentEvent.$type).toBe("space.roomy.message.deleteMessage.v0");
      expect(sentEvent.messageId).toBe(roomyMessageId);
    });
  });
});
