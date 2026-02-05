/**
 * Tests for ReactionSyncService.
 * TDD approach: Write failing test first, then implement.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockBridgeRepository } from "../../src/repositories/MockBridgeRepository.js";
import { ReactionSyncService } from "../../src/services/ReactionSyncService.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid, type Ulid } from "@roomy/sdk";
import type { Emoji } from "@discordeno/bot";

// Mock ConnectedSpace
const createMockConnectedSpace = () => ({
  sendEvent: async () => {},
});

describe("ReactionSyncService", () => {
  let repo: MockBridgeRepository;
  let service: ReactionSyncService;
  let mockSpace: ConnectedSpace;
  const guildId = 123456789n;
  const spaceId = "did:plc:test123";

  beforeEach(() => {
    repo = new MockBridgeRepository();
    repo.reset();
    mockSpace = createMockConnectedSpace() as unknown as ConnectedSpace;
    service = new ReactionSyncService(repo, mockSpace, guildId, spaceId);
  });

  describe("syncAddToRoomy", () => {
    it("should sync a Discord reaction add to Roomy", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // Set up mappings
      await repo.registerMapping(messageId.toString(), "roomy-msg-123");
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");

      let sentEvent: any;
      (mockSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncAddToRoomy(messageId, channelId, userId, emoji);

      // Verify the event was created
      expect(sentEvent).toBeDefined();
      expect(sentEvent.$type).toBe("space.roomy.reaction.addBridgedReaction.v0");
      expect(sentEvent.reactionTo).toBe("roomy-msg-123");
      expect(sentEvent.reaction).toBe("😀");
      expect(sentEvent.reactingUser).toBe("did:discord:444555666");

      // Verify reaction was tracked
      const key = `${messageId}:${userId}:😀`;
      expect(await repo.getReaction(key)).toBe(sentEvent.id);
    });

    it("should be idempotent - skip if already synced", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // Set up mappings
      await repo.registerMapping(messageId.toString(), "roomy-msg-123");
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");

      // Set existing reaction
      const existingEventId = "existing-reaction-id";
      const key = `${messageId}:${userId}:😀`;
      await repo.setReaction(key, existingEventId);

      let sendEventCalled = false;
      (mockSpace as any).sendEvent = async () => {
        sendEventCalled = true;
      };

      const result = await service.syncAddToRoomy(messageId, channelId, userId, emoji);

      // Should not send event if already synced
      expect(sendEventCalled).toBe(false);
      expect(result).toBe(existingEventId);
    });

    it("should return null if message not synced", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // Only set up channel mapping
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");

      let sendEventCalled = false;
      (mockSpace as any).sendEvent = async () => {
        sendEventCalled = true;
      };

      const result = await service.syncAddToRoomy(messageId, channelId, userId, emoji);

      expect(sendEventCalled).toBe(false);
      expect(result).toBeNull();
    });

    it("should return null if channel not synced", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // Only set up message mapping
      await repo.registerMapping(messageId.toString(), "roomy-msg-123");

      let sendEventCalled = false;
      (mockSpace as any).sendEvent = async () => {
        sendEventCalled = true;
      };

      const result = await service.syncAddToRoomy(messageId, channelId, userId, emoji);

      expect(sendEventCalled).toBe(false);
      expect(result).toBeNull();
    });

    it("should handle custom emoji format", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: 123456789n, name: "pepe", animated: false };

      // Set up mappings
      await repo.registerMapping(messageId.toString(), "roomy-msg-123");
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");

      let sentEvent: any;
      (mockSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncAddToRoomy(messageId, channelId, userId, emoji);

      // Custom emoji format: <:name:id>
      expect(sentEvent.reaction).toBe("<:pepe:123456789>");
    });

    it("should handle animated custom emoji format", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: 123456789n, name: "pepe", animated: true };

      // Set up mappings
      await repo.registerMapping(messageId.toString(), "roomy-msg-123");
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");

      let sentEvent: any;
      (mockSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncAddToRoomy(messageId, channelId, userId, emoji);

      // Animated custom emoji format: <a:name:id>
      expect(sentEvent.reaction).toBe("<a:pepe:123456789>");
    });

    it("should include discordReactionOrigin extension", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // Set up mappings
      await repo.registerMapping(messageId.toString(), "roomy-msg-123");
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");

      let sentEvent: any;
      (mockSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncAddToRoomy(messageId, channelId, userId, emoji);

      expect(sentEvent.extensions).toBeDefined();
      expect(
        sentEvent.extensions["space.roomy.extension.discordReactionOrigin.v0"],
      ).toBeDefined();

      const origin = sentEvent.extensions[
        "space.roomy.extension.discordReactionOrigin.v0"
      ] as any;
      expect(origin.$type).toBe("space.roomy.extension.discordReactionOrigin.v0");
      expect(origin.messageId).toBe("987654321");
      expect(origin.channelId).toBe("111222333");
      expect(origin.userId).toBe("444555666");
      expect(origin.emoji).toBe("😀");
      expect(origin.guildId).toBe("123456789");
    });
  });

  describe("syncRemoveToRoomy", () => {
    it("should sync a Discord reaction remove to Roomy", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // Set up mappings and reaction
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");
      const reactionEventId = "reaction-event-123";
      const key = `${messageId}:${userId}:😀`;
      await repo.setReaction(key, reactionEventId);

      let sentEvent: any;
      (mockSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncRemoveToRoomy(messageId, channelId, userId, emoji);

      // Verify the event was created
      expect(sentEvent).toBeDefined();
      expect(sentEvent.$type).toBe("space.roomy.reaction.removeBridgedReaction.v0");
      expect(sentEvent.reactionId).toBe(reactionEventId);
      expect(sentEvent.reactingUser).toBe("did:discord:444555666");

      // Verify reaction was removed from tracking
      expect(await repo.getReaction(key)).toBeUndefined();
    });

    it("should return early if reaction not found", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // Set up channel mapping but no reaction
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");

      let sendEventCalled = false;
      (mockSpace as any).sendEvent = async () => {
        sendEventCalled = true;
      };

      await service.syncRemoveToRoomy(messageId, channelId, userId, emoji);

      expect(sendEventCalled).toBe(false);
    });

    it("should return early if channel not synced", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // No mappings set up

      let sendEventCalled = false;
      (mockSpace as any).sendEvent = async () => {
        sendEventCalled = true;
      };

      await service.syncRemoveToRoomy(messageId, channelId, userId, emoji);

      expect(sendEventCalled).toBe(false);
    });

    it("should include discordReactionOrigin extension on remove", async () => {
      const messageId = 987654321n;
      const channelId = 111222333n;
      const userId = 444555666n;
      const emoji: Partial<Emoji> = { id: null, name: "😀", animated: false };

      // Set up mappings and reaction
      await repo.registerMapping(`room:${channelId.toString()}`, "roomy-room-456");
      const reactionEventId = "reaction-event-123";
      const key = `${messageId}:${userId}:😀`;
      await repo.setReaction(key, reactionEventId);

      let sentEvent: any;
      (mockSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncRemoveToRoomy(messageId, channelId, userId, emoji);

      expect(sentEvent.extensions).toBeDefined();
      const origin = sentEvent.extensions[
        "space.roomy.extension.discordReactionOrigin.v0"
      ] as any;
      expect(origin.$type).toBe("space.roomy.extension.discordReactionOrigin.v0");
      expect(origin.emoji).toBe("😀");
    });
  });

  describe("getReactionKey", () => {
    it("should generate correct key for unicode emoji", () => {
      const key = service.getReactionKey(123n, 456n, { name: "😀" });
      expect(key).toBe("123:456:😀");
    });

    it("should generate correct key for custom emoji", () => {
      const key = service.getReactionKey(123n, 456n, { id: 789n, name: "pepe" });
      expect(key).toBe("123:456:789");
    });

    it("should generate correct key for animated custom emoji", () => {
      const key = service.getReactionKey(123n, 456n, { id: 789n, name: "pepe", animated: true });
      expect(key).toBe("123:456:789");
    });
  });
});
