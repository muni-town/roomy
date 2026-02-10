/**
 * Mock implementation of BridgeRepository for testing.
 * Uses in-memory storage instead of LevelDB.
 */

import type { BridgeRepository } from "./BridgeRepository.js";
import type { RoomyUserProfile, SyncedEdit } from "./BridgeRepository.js";

/**
 * In-memory mock implementation of BridgeRepository.
 * Useful for unit tests without requiring a real database.
 */
export class MockBridgeRepository implements BridgeRepository {
  private readonly roomyIds = new Map<string, string>();
  private readonly discordIds = new Map<string, string>();
  private readonly profileHashes = new Map<string, string>();
  private readonly roomyUserProfiles = new Map<string, RoomyUserProfile>();
  private readonly reactions = new Map<string, string>();
  private sidebarHash: string | undefined;
  private readonly roomLinks = new Map<string, string>();
  private readonly editInfos = new Map<string, SyncedEdit>();
  private readonly webhookTokens = new Map<string, string>();
  private messageHashes: Record<string, string> = {};
  private readonly latestMessages = new Map<string, string>();
  private readonly cursors = new Map<string, number>();
  private readonly guildToSpace = new Map<string, string>();
  private readonly spaceToGuild = new Map<string, string>();

  // Test helpers
  private readonly calls: Record<string, number> = {};

  /**
   * Get the number of times a method was called.
   * Useful for assertions in tests.
   */
  getCallCount(methodName: string): number {
    return this.calls[methodName] || 0;
  }

  /**
   * Reset all call counters.
   */
  resetCallCounts(): void {
    for (const key in this.calls) {
      delete this.calls[key];
    }
  }

  /**
   * Reset all stored data.
   */
  reset(): void {
    this.roomyIds.clear();
    this.discordIds.clear();
    this.profileHashes.clear();
    this.roomyUserProfiles.clear();
    this.reactions.clear();
    this.sidebarHash = undefined;
    this.roomLinks.clear();
    this.editInfos.clear();
    this.webhookTokens.clear();
    this.messageHashes = {};
    this.latestMessages.clear();
    this.cursors.clear();
    this.guildToSpace.clear();
    this.spaceToGuild.clear();
    this.resetCallCounts();
  }

  async delete(): Promise<void> {
    this.trackCall("delete");
    this.reset();
  }

  private trackCall(method: string): void {
    this.calls[method] = (this.calls[method] || 0) + 1;
  }

  // === ID Mapping ===

  async getRoomyId(discordId: string): Promise<string | undefined> {
    this.trackCall("getRoomyId");
    return this.roomyIds.get(discordId);
  }

  async getDiscordId(roomyId: string): Promise<string | undefined> {
    this.trackCall("getDiscordId");
    return this.discordIds.get(roomyId);
  }

  async registerMapping(discordId: string, roomyId: string): Promise<void> {
    this.trackCall("registerMapping");
    if (this.roomyIds.has(discordId) || this.discordIds.has(roomyId)) {
      throw new Error("Already registered");
    }
    this.roomyIds.set(discordId, roomyId);
    this.discordIds.set(roomyId, discordId);
  }

  async unregisterMapping(discordId: string, roomyId: string): Promise<void> {
    this.trackCall("unregisterMapping");
    const existingRoomyId = this.roomyIds.get(discordId);
    const existingDiscordId = this.discordIds.get(roomyId);
    if (existingRoomyId !== roomyId || existingDiscordId !== discordId) {
      throw new Error("Mapping not found");
    }
    this.roomyIds.delete(discordId);
    this.discordIds.delete(roomyId);
  }

  async listMappings(): Promise<Array<{ discordId: string; roomyId: string }>> {
    this.trackCall("listMappings");
    return Array.from(this.roomyIds.entries()).map(([discordId, roomyId]) => ({
      discordId,
      roomyId,
    }));
  }

  async clearMappings(): Promise<void> {
    this.trackCall("clearMappings");
    this.roomyIds.clear();
    this.discordIds.clear();
  }

  // === Profile Sync ===

  async getProfileHash(userId: string): Promise<string | undefined> {
    this.trackCall("getProfileHash");
    return this.profileHashes.get(userId);
  }

  async setProfileHash(userId: string, hash: string): Promise<void> {
    this.trackCall("setProfileHash");
    this.profileHashes.set(userId, hash);
  }

  async getRoomyUserProfile(did: string): Promise<RoomyUserProfile | undefined> {
    this.trackCall("getRoomyUserProfile");
    return this.roomyUserProfiles.get(did);
  }

  async setRoomyUserProfile(did: string, profile: RoomyUserProfile): Promise<void> {
    this.trackCall("setRoomyUserProfile");
    this.roomyUserProfiles.set(did, profile);
  }

  // === Reactions ===

  async getReaction(key: string): Promise<string | undefined> {
    this.trackCall("getReaction");
    return this.reactions.get(key);
  }

  async setReaction(key: string, reactionEventId: string): Promise<void> {
    this.trackCall("setReaction");
    this.reactions.set(key, reactionEventId);
  }

  async deleteReaction(key: string): Promise<void> {
    this.trackCall("deleteReaction");
    this.reactions.delete(key);
  }

  // === Sidebar ===

  async getSidebarHash(): Promise<string | undefined> {
    this.trackCall("getSidebarHash");
    return this.sidebarHash;
  }

  async setSidebarHash(hash: string): Promise<void> {
    this.trackCall("setSidebarHash");
    this.sidebarHash = hash;
  }

  // === Room Links ===

  async getRoomLink(key: string): Promise<string | undefined> {
    this.trackCall("getRoomLink");
    return this.roomLinks.get(key);
  }

  async setRoomLink(key: string, linkEventId: string): Promise<void> {
    this.trackCall("setRoomLink");
    this.roomLinks.set(key, linkEventId);
  }

  // === Message Edits ===

  async getEditInfo(messageId: string): Promise<SyncedEdit | undefined> {
    this.trackCall("getEditInfo");
    return this.editInfos.get(messageId);
  }

  async setEditInfo(messageId: string, editInfo: SyncedEdit): Promise<void> {
    this.trackCall("setEditInfo");
    this.editInfos.set(messageId, editInfo);
  }

  // === Webhooks ===

  async getWebhookToken(channelId: string): Promise<string | undefined> {
    this.trackCall("getWebhookToken");
    return this.webhookTokens.get(channelId);
  }

  async setWebhookToken(channelId: string, token: string): Promise<void> {
    this.trackCall("setWebhookToken");
    this.webhookTokens.set(channelId, token);
  }

  async deleteWebhookToken(channelId: string): Promise<void> {
    this.trackCall("deleteWebhookToken");
    this.webhookTokens.delete(channelId);
  }

  // === Message Hashes ===

  async getMessageHashes(): Promise<Record<string, string>> {
    this.trackCall("getMessageHashes");
    return { ...this.messageHashes };
  }

  async setMessageHashes(hashes: Record<string, string>): Promise<void> {
    this.trackCall("setMessageHashes");
    this.messageHashes = { ...hashes };
  }

  // === Latest Messages ===

  async getLatestMessage(channelId: string): Promise<string | undefined> {
    this.trackCall("getLatestMessage");
    return this.latestMessages.get(channelId);
  }

  async setLatestMessage(channelId: string, messageId: string): Promise<void> {
    this.trackCall("setLatestMessage");
    this.latestMessages.set(channelId, messageId);
  }

  // === Leaf Cursors ===

  async getCursor(spaceId: string): Promise<number | undefined> {
    this.trackCall("getCursor");
    return this.cursors.get(spaceId);
  }

  async setCursor(spaceId: string, idx: number): Promise<void> {
    this.trackCall("setCursor");
    this.cursors.set(spaceId, idx);
  }

  // === Registered Bridges ===

  async getSpaceId(guildId: string): Promise<string | undefined> {
    this.trackCall("getSpaceId");
    return this.guildToSpace.get(guildId);
  }

  async getGuildId(spaceId: string): Promise<string | undefined> {
    this.trackCall("getGuildId");
    return this.spaceToGuild.get(spaceId);
  }

  /**
   * Get the last processed index for a space, or 1 if not found.
   * Leaf stream indices are 1-based, so new subscriptions should start at 1.
   */
  async getLastProcessedIdx(spaceId: string): Promise<number> {
    this.trackCall("getLastProcessedIdx");
    return this.cursors.get(spaceId) ?? 1;
  }

  // === Test helpers for registered bridges ===

  /**
   * Register a bridge mapping for testing.
   */
  setBridge(guildId: string, spaceId: string): void {
    this.guildToSpace.set(guildId, spaceId);
    this.spaceToGuild.set(spaceId, guildId);
  }
}
