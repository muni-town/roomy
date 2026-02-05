/**
 * Tests for SyncOrchestrator.
 * TDD approach: Write failing test first, then implement.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockBridgeRepository } from "../../src/repositories/MockBridgeRepository.js";
import { SyncOrchestrator } from "../../src/services/SyncOrchestrator.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid } from "@roomy/sdk";
import type { DiscordBot } from "../../src/discord/types.js";
import type { MessageProperties, ChannelProperties } from "../../src/discord/types.js";
import { ProfileSyncService } from "../../src/services/ProfileSyncService.js";
import { ReactionSyncService } from "../../src/services/ReactionSyncService.js";
import { StructureSyncService } from "../../src/services/StructureSyncService.js";
import { MessageSyncService } from "../../src/services/MessageSyncService.js";
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

describe("SyncOrchestrator", () => {
  let repo: MockBridgeRepository;
  let orchestrator: SyncOrchestrator;
  let mockSpace: ConnectedSpace;
  let mockBot: DiscordBot;
  let profileService: ProfileSyncService;
  let reactionService: ReactionSyncService;
  let structureService: StructureSyncService;
  let messageService: MessageSyncService;
  const guildId = 123456789n;
  const spaceId = "did:plc:test123";

  beforeEach(() => {
    repo = new MockBridgeRepository();
    repo.reset();
    mockSpace = createMockConnectedSpace() as unknown as ConnectedSpace;
    mockBot = createMockBot();

    profileService = new ProfileSyncService(repo, mockSpace, guildId, spaceId);
    reactionService = new ReactionSyncService(repo, mockSpace, guildId, spaceId);
    structureService = new StructureSyncService(repo, mockSpace, guildId, spaceId);
    messageService = new MessageSyncService(
      repo,
      mockSpace,
      guildId,
      spaceId,
      profileService,
      mockBot,
    );

    orchestrator = new SyncOrchestrator(
      messageService,
      reactionService,
      profileService,
      structureService,
    );
  });

  describe("Discord event handlers", () => {
    it("should handle Discord message create", async () => {
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

      await orchestrator.handleDiscordMessageCreate(discordMessage, roomyRoomId);

      // Should have called the message service
      expect(await repo.getRoomyId(discordMessage.id.toString())).toBeDefined();
    });

    it("should handle Discord message update", async () => {
      const roomyRoomId = "target-room-123";
      const editedMessage: MessageProperties = {
        id: 987654321n,
        content: "Edited",
        channelId: 111222333n,
        author: {
          id: 444555666n,
          username: "testuser",
          discriminator: "0001",
          avatar: null,
        },
        timestamp: Date.now(),
        editedTimestamp: Date.now(),
        type: DISCORD_MESSAGE_TYPES.DEFAULT,
        attachments: [],
        webhookId: null,
      } as any;

      await repo.registerMapping(editedMessage.id.toString(), "roomy-msg-456");
      await repo.registerMapping(`room:${editedMessage.channelId.toString()}`, roomyRoomId);

      await orchestrator.handleDiscordMessageUpdate(editedMessage);

      // Should have sent an edit event
      expect(mockSpace.sendEvent).toHaveBeenCalled();
    });

    it("should handle Discord message delete", async () => {
      const messageId = 987654321n;
      await repo.registerMapping(messageId.toString(), "roomy-msg-456");
      await repo.registerMapping("roomy-msg-456", "room-room-123");

      await orchestrator.handleDiscordMessageDelete(messageId);

      // Should have sent a delete event
      expect(mockSpace.sendEvent).toHaveBeenCalled();
    });

    it("should handle Discord reaction add", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji = { id: null, name: "😀", animated: false };

      await repo.registerMapping(messageId.toString(), "roomy-msg-456");
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-123");

      await orchestrator.handleDiscordReactionAdd(messageId, channelId, userId, emoji);

      // Should have sent a reaction add event
      expect(mockSpace.sendEvent).toHaveBeenCalled();
    });

    it("should handle Discord reaction remove", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji = { id: null, name: "😀", animated: false };
      const reactionKey = `${messageId}:${userId}:😀`;

      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-123");
      await repo.setReaction(reactionKey, "reaction-event-123");

      await orchestrator.handleDiscordReactionRemove(messageId, channelId, userId, emoji);

      // Should have sent a reaction remove event
      expect(mockSpace.sendEvent).toHaveBeenCalled();
    });

    it("should handle Discord channel create", async () => {
      const discordChannel: ChannelProperties = {
        id: 987654321n,
        name: "general",
        type: 0,
      } as any;

      await orchestrator.handleDiscordChannelCreate(discordChannel);

      // Should have created a Roomy room
      expect(mockSpace.sendEvent).toHaveBeenCalled();
      expect(await repo.getRoomyId("room:987654321")).toBeDefined();
    });

    it("should handle Discord thread create", async () => {
      const discordThread: ChannelProperties = {
        id: 111222333n,
        name: "thread-name",
        type: 11,
        parentId: 987654321n,
      } as any;

      const parentChannelId = 987654321n;

      // Set up parent channel
      await repo.registerMapping(`room:${parentChannelId.toString()}`, "parent-room-123");

      await orchestrator.handleDiscordThreadCreate(discordThread, parentChannelId);

      // Should have created a thread with link
      expect(mockSpace.sendEvent).toHaveBeenCalled();
    });

    it("should handle full Discord sidebar update", async () => {
      const channels: ChannelProperties[] = [
        { id: 111n, name: "general", type: 0, parentId: null } as any,
      ];
      const categories = [];

      await repo.registerMapping("room:111", "roomy-111");

      await orchestrator.handleDiscordSidebarUpdate(channels, categories);

      // Should have sent sidebar update
      expect(mockSpace.sendEvent).toHaveBeenCalled();
      expect(await repo.getSidebarHash()).toBeDefined();
    });
  });

  describe("Roomy event handlers (stubs)", () => {
    it("should handle Roomy create message (stub - throws)", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.message.createMessage.v0",
      } as any;

      await expect(
        orchestrator.handleRoomyCreateMessage(event, mockBot)
      ).rejects.toThrow("Not implemented");
    });

    it("should handle Roomy edit message (stub - throws)", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.message.editMessage.v0",
      } as any;

      await expect(
        orchestrator.handleRoomyEditMessage(event, mockBot)
      ).rejects.toThrow("Not implemented");
    });

    it("should handle Roomy delete message (stub - throws)", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.message.deleteMessage.v0",
      } as any;

      await expect(
        orchestrator.handleRoomyDeleteMessage(event, mockBot)
      ).rejects.toThrow("Not implemented");
    });

    it("should handle Roomy add reaction (stub - throws)", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.reaction.addReaction.v0",
      } as any;

      await expect(
        orchestrator.handleRoomyAddReaction(event, mockBot)
      ).rejects.toThrow("Not implemented");
    });

    it("should handle Roomy remove reaction (stub - throws)", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.reaction.removeReaction.v0",
      } as any;

      await expect(
        orchestrator.handleRoomyRemoveReaction(event, mockBot)
      ).rejects.toThrow("Not implemented");
    });

    it("should handle Roomy create room (stub - throws)", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.room.createRoom.v0",
      } as any;

      await expect(
        orchestrator.handleRoomyCreateRoom(event, mockBot)
      ).rejects.toThrow("Not implemented");
    });

    it("should handle Roomy update sidebar (stub - throws)", async () => {
      const event = {
        id: newUlid(),
        $type: "space.roomy.space.updateSidebar.v0",
      } as any;

      await expect(
        orchestrator.handleRoomyUpdateSidebar(event, mockBot)
      ).rejects.toThrow("Not implemented");
    });
  });
});
