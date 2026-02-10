/**
 * Tests for ProfileSyncService.
 * TDD approach: Write failing test first, then implement.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockBridgeRepository } from "../../src/repositories/MockBridgeRepository.js";
import { ProfileSyncService } from "../../src/services/ProfileSyncService.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid } from "@roomy/sdk";

// Mock ConnectedSpace
const mockConnectedSpace = {
  sendEvent: async () => {},
} as unknown as ConnectedSpace;

describe("ProfileSyncService", () => {
  let repo: MockBridgeRepository;
  let service: ProfileSyncService;
  const guildId = 123456789n;
  const spaceId = "did:plc:test123";

  beforeEach(() => {
    repo = new MockBridgeRepository();
    repo.reset();
    service = new ProfileSyncService(repo, mockConnectedSpace, guildId);
  });

  describe("syncDiscordToRoomy", () => {
    it("should create updateProfile event for new Discord user", async () => {
      const discordUser = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: "Test User",
        avatar: "abc123hash",
      };

      let sentEvent: any;
      (mockConnectedSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncDiscordToRoomy(discordUser);

      // Verify the event was created
      expect(sentEvent).toBeDefined();
      expect(sentEvent.$type).toBe("space.roomy.user.updateProfile.v0");
      expect(sentEvent.did).toBe("did:discord:987654321");

      // Verify profile data (globalName takes precedence over username)
      expect(sentEvent.name).toBe("Test User");

      // Verify avatar URL
      expect(sentEvent.avatar).toContain("abc123hash");

      // Verify hash was cached
      const cachedHash = await repo.getProfileHash("987654321");
      expect(cachedHash).toBeDefined();
    });

    it("should skip syncing if profile hash matches (idempotency)", async () => {
      const discordUser = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: "Test User",
        avatar: "abc123hash",
      };

      // Set existing hash
      const existingHash = service.computeProfileHash(discordUser);
      await repo.setProfileHash("987654321", existingHash);

      let sendEventCalled = false;
      (mockConnectedSpace as any).sendEvent = async () => {
        sendEventCalled = true;
      };

      await service.syncDiscordToRoomy(discordUser);

      // Should not send event if profile unchanged
      expect(sendEventCalled).toBe(false);
    });

    it("should resync if profile data has changed", async () => {
      const discordUser = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: "Test User",
        avatar: "abc123hash",
      };

      // Set old hash (different data)
      await repo.setProfileHash("987654321", "old-hash-different");

      let sendEventCalled = false;
      (mockConnectedSpace as any).sendEvent = async () => {
        sendEventCalled = true;
      };

      await service.syncDiscordToRoomy(discordUser);

      // Should send event for changed profile
      expect(sendEventCalled).toBe(true);
    });

    it("should build correct avatar URL", async () => {
      const discordUser = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: null,
        avatar: "abc123hash",
      };

      let sentEvent: any;
      (mockConnectedSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncDiscordToRoomy(discordUser);

      // Avatar URL format from discordeno: https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.{format}?size={size}
      expect(sentEvent.avatar).toBe(
        `https://cdn.discordapp.com/avatars/987654321/abc123hash.webp?size=256`,
      );
    });

    it("should handle null avatar", async () => {
      const discordUser = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: null,
        avatar: null,
      };

      let sentEvent: any;
      (mockConnectedSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncDiscordToRoomy(discordUser);

      // Discord provides default avatar when none is set
      expect(sentEvent.avatar).toContain("cdn.discordapp.com/embed/avatars");
    });

    it("should include discordUserOrigin extension", async () => {
      const discordUser = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: "Test User",
        avatar: "abc123hash",
      };

      let sentEvent: any;
      (mockConnectedSpace as any).sendEvent = async (event: any) => {
        sentEvent = event;
      };

      await service.syncDiscordToRoomy(discordUser);

      expect(sentEvent.extensions).toBeDefined();
      expect(
        sentEvent.extensions["space.roomy.extension.discordUserOrigin.v0"],
      ).toBeDefined();

      const origin = sentEvent.extensions[
        "space.roomy.extension.discordUserOrigin.v0"
      ] as any;
      expect(origin.$type).toBe("space.roomy.extension.discordUserOrigin.v0");
      expect(origin.snowflake).toBe("987654321");
      expect(origin.guildId).toBe("123456789");
      expect(origin.profileHash).toBeDefined();
    });

    it("should support optional batcher parameter", async () => {
      const discordUser = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: null,
        avatar: null,
      };

      let batcherCalled = false;
      const mockBatcher = {
        add: async (event: any) => {
          batcherCalled = true;
        },
      };

      await service.syncDiscordToRoomy(discordUser, mockBatcher as any);

      expect(batcherCalled).toBe(true);
    });
  });

  describe("computeProfileHash", () => {
    it("should generate consistent hash for same data", async () => {
      const discordUser = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: "Test User",
        avatar: "abc123hash",
      };

      const hash1 = await service.computeProfileHash(discordUser);
      const hash2 = await service.computeProfileHash(discordUser);

      expect(hash1).toBe(hash2);
    });

    it("should generate different hash for different data", async () => {
      const user1 = {
        id: 987654321n,
        username: "testuser",
        discriminator: "0001",
        globalName: "Test User",
        avatar: "abc123hash",
      };

      const user2 = {
        id: 987654321n,
        username: "differentuser",
        discriminator: "0001",
        globalName: "Test User",
        avatar: "abc123hash",
      };

      const hash1 = service.computeProfileHash(user1);
      const hash2 = service.computeProfileHash(user2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("handleRoomyEvent", () => {
    it("should cache Discord user profile hash", async () => {
      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.user.updateProfile.v0",
          id: newUlid(),
          did: "did:discord:123",
          name: "Test User",
          avatar: "https://example.com/avatar.png",
          extensions: {
            "space.roomy.extension.discordUserOrigin.v0": {
              snowflake: "123",
              guildId: guildId.toString(),
              profileHash: "abc123",
              handle: "user#0001",
            },
          },
        },
        user: "did:discord:123" as any,
      } as any;

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(true);
      const hash = await repo.getProfileHash("123");
      expect(hash).toBe("abc123");
    });

    it("should cache Roomy user profile for non-Discord users", async () => {
      const did = "did:alice:123";
      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.user.updateProfile.v0",
          id: newUlid(),
          did,
          name: "Alice",
          avatar: "https://example.com/alice.png",
        },
        user: did as any,
      } as any;

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(true);
      const profile = await repo.getRoomyUserProfile(did);
      expect(profile?.name).toBe("Alice");
      expect(profile?.avatar).toBe("https://example.com/alice.png");
    });

    it("should use 'Unknown' as fallback name when name is missing", async () => {
      const did = "did:alice:456";
      const event = {
        idx: 1,
        event: {
          $type: "space.roomy.user.updateProfile.v0",
          id: newUlid(),
          did,
          avatar: null,
        },
        user: did as any,
      } as any;

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(true);
      const profile = await repo.getRoomyUserProfile(did);
      expect(profile?.name).toBe("Unknown");
      expect(profile?.avatar).toBeNull();
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
          $type: "space.roomy.user.updateProfile.v0",
          id: newUlid(),
          did: "did:alice:123",
          name: "Alice",
        },
        user: "did:alice:123" as any,
      } as any;

      vi.spyOn(repo, "setRoomyUserProfile").mockRejectedValue(
        new Error("DB error"),
      );

      const result = await service.handleRoomyEvent(event);

      expect(result).toBe(false);
    });
  });
});
