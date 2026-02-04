/**
 * Tests for BridgeRepository implementations.
 * Demonstrates both the LevelDB and Mock implementations.
 */

import { describe, it, expect } from "vitest";
import { MockBridgeRepository } from "../../src/repositories/MockBridgeRepository.js";
import type { RoomyUserProfile, SyncedEdit } from "../../src/repositories/BridgeRepository.js";

describe("MockBridgeRepository", () => {
  it("should store and retrieve Roomy IDs", async () => {
    const repo = new MockBridgeRepository();

    // Initially empty
    expect(await repo.getRoomyId("discord:123")).toBeUndefined();

    // Register mapping
    await repo.registerMapping("discord:123", "roomy:abc");

    // Now retrievable
    expect(await repo.getRoomyId("discord:123")).toBe("roomy:abc");
    expect(await repo.getDiscordId("roomy:abc")).toBe("discord:123");
  });

  it("should handle bidirectional lookups", async () => {
    const repo = new MockBridgeRepository();

    await repo.registerMapping("123", "abc");
    await repo.registerMapping("456", "def");

    expect(await repo.getRoomyId("123")).toBe("abc");
    expect(await repo.getRoomyId("456")).toBe("def");
    expect(await repo.getDiscordId("abc")).toBe("123");
    expect(await repo.getDiscordId("def")).toBe("456");
  });

  it("should prevent duplicate registrations", async () => {
    const repo = new MockBridgeRepository();

    await repo.registerMapping("123", "abc");

    await expect(repo.registerMapping("123", "xyz")).rejects.toThrow("Already registered");
    await expect(repo.registerMapping("999", "abc")).rejects.toThrow("Already registered");
  });

  it("should track method calls", async () => {
    const repo = new MockBridgeRepository();

    await repo.registerMapping("123", "abc");
    await repo.getRoomyId("123");

    expect(repo.getCallCount("registerMapping")).toBe(1);
    expect(repo.getCallCount("getRoomyId")).toBe(1);
    expect(repo.getCallCount("getDiscordId")).toBe(0);
  });

  it("should reset call counts", async () => {
    const repo = new MockBridgeRepository();

    await repo.registerMapping("123", "abc");
    repo.resetCallCounts();

    expect(repo.getCallCount("registerMapping")).toBe(0);
  });

  it("should clear all data", async () => {
    const repo = new MockBridgeRepository();

    await repo.registerMapping("123", "abc");
    await repo.setProfileHash("user1", "hash1");
    await repo.setReaction("reaction:1", "event1");

    repo.reset();

    expect(await repo.getRoomyId("123")).toBeUndefined();
    expect(await repo.getProfileHash("user1")).toBeUndefined();
    expect(await repo.getReaction("reaction:1")).toBeUndefined();
  });

  // === Profile Sync ===

  it("should store and retrieve profile hashes", async () => {
    const repo = new MockBridgeRepository();

    await repo.setProfileHash("user123", "hash-abc-123");
    expect(await repo.getProfileHash("user123")).toBe("hash-abc-123");
  });

  it("should store and retrieve Roomy user profiles", async () => {
    const repo = new MockBridgeRepository();

    const profile: RoomyUserProfile = {
      name: "Test User",
      avatar: "https://example.com/avatar.png",
      handle: "testuser",
    };

    await repo.setRoomyUserProfile("did:plc:123", profile);
    expect(await repo.getRoomyUserProfile("did:plc:123")).toEqual(profile);
  });

  // === Reactions ===

  it("should store and retrieve reactions", async () => {
    const repo = new MockBridgeRepository();

    await repo.setReaction("msg123:user456:😀", "reaction-event-id");
    expect(await repo.getReaction("msg123:user456:😀")).toBe("reaction-event-id");
  });

  it("should delete reactions", async () => {
    const repo = new MockBridgeRepository();

    await repo.setReaction("msg123:user456:😀", "reaction-event-id");
    await repo.deleteReaction("msg123:user456:😀");

    expect(await repo.getReaction("msg123:user456:😀")).toBeUndefined();
  });

  // === Sidebar ===

  it("should store and retrieve sidebar hash", async () => {
    const repo = new MockBridgeRepository();

    await repo.setSidebarHash("sidebar-hash-123");
    expect(await repo.getSidebarHash()).toBe("sidebar-hash-123");
  });

  // === Room Links ===

  it("should store and retrieve room links", async () => {
    const repo = new MockBridgeRepository();

    await repo.setRoomLink("parent:child", "link-event-id");
    expect(await repo.getRoomLink("parent:child")).toBe("link-event-id");
  });

  // === Message Edits ===

  it("should store and retrieve edit info", async () => {
    const repo = new MockBridgeRepository();

    const editInfo: SyncedEdit = {
      editedTimestamp: Date.now(),
      contentHash: "abc123",
    };

    await repo.setEditInfo("msg123", editInfo);
    expect(await repo.getEditInfo("msg123")).toEqual(editInfo);
  });

  // === Webhooks ===

  it("should store and retrieve webhook tokens", async () => {
    const repo = new MockBridgeRepository();

    await repo.setWebhookToken("channel123", "webhook-id:token");
    expect(await repo.getWebhookToken("channel123")).toBe("webhook-id:token");
  });

  it("should delete webhook tokens", async () => {
    const repo = new MockBridgeRepository();

    await repo.setWebhookToken("channel123", "webhook-id:token");
    await repo.deleteWebhookToken("channel123");

    expect(await repo.getWebhookToken("channel123")).toBeUndefined();
  });

  // === Message Hashes ===

  it("should store and retrieve message hashes", async () => {
    const repo = new MockBridgeRepository();

    const hashes = {
      "nonce1:hash1": "msg1",
      "nonce2:hash2": "msg2",
      ":hash3": "msg3",
    };

    await repo.setMessageHashes(hashes);
    expect(await repo.getMessageHashes()).toEqual(hashes);
  });

  // === Latest Messages ===

  it("should store and retrieve latest messages", async () => {
    const repo = new MockBridgeRepository();

    await repo.setLatestMessage("channel123", "msg456");
    expect(await repo.getLatestMessage("channel123")).toBe("msg456");
  });

  // === Listing ===

  it("should list all mappings", async () => {
    const repo = new MockBridgeRepository();

    await repo.registerMapping("111", "aaa");
    await repo.registerMapping("222", "bbb");
    await repo.registerMapping("333", "ccc");

    const mappings = await repo.listMappings();
    expect(mappings).toHaveLength(3);
    expect(mappings).toContainEqual({ discordId: "111", roomyId: "aaa" });
    expect(mappings).toContainEqual({ discordId: "222", roomyId: "bbb" });
    expect(mappings).toContainEqual({ discordId: "333", roomyId: "ccc" });
  });
});
