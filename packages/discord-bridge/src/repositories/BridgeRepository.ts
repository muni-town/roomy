/**
 * Repository interface for Discord ↔ Roomy bridge data access.
 * Abstracts database operations to enable testing with mock implementations.
 */

import type {
  BidirectionalSublevelMap,
  SyncedProfiles,
  RoomyUserProfiles,
  SyncedReactions,
  SyncedSidebarHash,
  SyncedRoomLinks,
  SyncedEdits,
  DiscordMessageHashes,
  LatestMessages,
  RoomyUserProfile,
  SyncedEdit,
} from "./db.js";

/**
 * Roomy user profile information
 */
export type { RoomyUserProfile };

/**
 * Message edit tracking information
 */
export type { SyncedEdit };

/**
 * Roomy room link information
 */
export interface RoomLink {
  parentRoomyId: string;
  childRoomyId: string;
  linkEventId: string;
}

/**
 * Discord webhook token information
 */
export interface WebhookToken {
  channelId: string;
  webhookId: string;
  token: string;
}

/**
 * Repository for Discord ↔ Roomy bridge data access.
 * Provides a clean abstraction over LevelDB operations.
 */
export interface BridgeRepository {
  // === ID Mapping (Bidirectional) ===

  /**
   * Get the Roomy ID for a Discord ID.
   * @param discordId - Discord snowflake or "room:" prefixed channel/thread ID
   * @returns Roomy ULID or undefined if not found
   */
  getRoomyId(discordId: string): Promise<string | undefined>;

  /**
   * Get the Discord ID for a Roomy ID.
   * @param roomyId - Roomy ULID
   * @returns Discord snowflake (with "room:" prefix for channels/threads) or undefined
   */
  getDiscordId(roomyId: string): Promise<string | undefined>;

  /**
   * Register a bidirectional Discord ↔ Roomy ID mapping.
   * @param discordId - Discord snowflake or "room:" prefixed channel/thread ID
   * @param roomyId - Roomy ULID
   */
  registerMapping(discordId: string, roomyId: string): Promise<void>;

  /**
   * Unregister a bidirectional mapping.
   */
  unregisterMapping(discordId: string, roomyId: string): Promise<void>;

  /**
   * List all registered mappings.
   */
  listMappings(): Promise<Array<{ discordId: string; roomyId: string }>>;

  /**
   * Clear all mappings.
   */
  clearMappings(): Promise<void>;

  // === Profile Sync ===

  /**
   * Get the profile hash for a Discord user.
   * Used for change detection to avoid redundant profile updates.
   */
  getProfileHash(userId: string): Promise<string | undefined>;

  /**
   * Set the profile hash for a Discord user.
   */
  setProfileHash(userId: string, hash: string): Promise<void>;

  /**
   * Get a Roomy user's profile from cache.
   */
  getRoomyUserProfile(did: string): Promise<RoomyUserProfile | undefined>;

  /**
   * Cache a Roomy user's profile.
   */
  setRoomyUserProfile(did: string, profile: RoomyUserProfile): Promise<void>;

  // === Reactions ===

  /**
   * Get the Roomy reaction event ID for a Discord reaction.
   * @param key - `${messageId}:${userId}:${emojiKey}`
   */
  getReaction(key: string): Promise<string | undefined>;

  /**
   * Register a Discord reaction mapping.
   */
  setReaction(key: string, reactionEventId: string): Promise<void>;

  /**
   * Remove a Discord reaction mapping.
   */
  deleteReaction(key: string): Promise<void>;

  // === Sidebar ===

  /**
   * Get the sidebar hash for change detection.
   */
  getSidebarHash(): Promise<string | undefined>;

  /**
   * Set the sidebar hash.
   */
  setSidebarHash(hash: string): Promise<void>;

  // === Room Links ===

  /**
   * Get a room link event ID.
   * @param key - `${parentRoomyId}:${childRoomyId}`
   */
  getRoomLink(key: string): Promise<string | undefined>;

  /**
   * Register a room link.
   */
  setRoomLink(key: string, linkEventId: string): Promise<void>;

  // === Message Edits ===

  /**
   * Get edit tracking info for a message.
   */
  getEditInfo(messageId: string): Promise<SyncedEdit | undefined>;

  /**
   * Set edit tracking info for a message.
   */
  setEditInfo(messageId: string, editInfo: SyncedEdit): Promise<void>;

  // === Webhooks ===

  /**
   * Get the webhook token for a channel.
   * @returns "webhookId:token" string or undefined
   */
  getWebhookToken(channelId: string): Promise<string | undefined>;

  /**
   * Set the webhook token for a channel.
   * @param token - "webhookId:token" string
   */
  setWebhookToken(channelId: string, token: string): Promise<void>;

  /**
   * Delete the webhook token for a channel.
   */
  deleteWebhookToken(channelId: string): Promise<void>;

  // === Message Hashes ===

  /**
   * Get all message hashes for duplicate detection.
   */
  getMessageHashes(): Promise<Record<string, string>>;

  /**
   * Set all message hashes.
   */
  setMessageHashes(hashes: Record<string, string>): Promise<void>;

  // === Latest Messages ===

  /**
   * Get the latest message ID for a channel.
   */
  getLatestMessage(channelId: string): Promise<string | undefined>;

  /**
   * Set the latest message ID for a channel.
   */
  setLatestMessage(channelId: string, messageId: string): Promise<void>;
}

/**
 * Implementation of BridgeRepository using real LevelDB stores.
 * This wraps the existing GuildContext stores in the repository interface.
 */
export class LevelDBBridgeRepository implements BridgeRepository {
  constructor(
    private readonly stores: {
      syncedIds: BidirectionalSublevelMap<"discordId", "roomyId">;
      syncedProfiles: SyncedProfiles;
      roomyUserProfiles: RoomyUserProfiles;
      syncedReactions: SyncedReactions;
      syncedSidebarHash: SyncedSidebarHash;
      syncedRoomLinks: SyncedRoomLinks;
      syncedEdits: SyncedEdits;
      discordWebhookTokens: ReturnType<
        typeof import("./db.js").discordWebhookTokensForBridge
      >;
      discordMessageHashes: DiscordMessageHashes;
      discordLatestMessage: LatestMessages;
    },
  ) {}

  // === ID Mapping ===

  async getRoomyId(discordId: string): Promise<string | undefined> {
    /** WARNING: this looks wrong but is actually correct.
     * The naming is short for 'get the value with key prefixed by `discordId`.
     */
    return this.stores.syncedIds.get_discordId(discordId);
  }

  async getDiscordId(roomyId: string): Promise<string | undefined> {
    /** WARNING: See above. */
    return this.stores.syncedIds.get_roomyId(roomyId);
  }

  async registerMapping(discordId: string, roomyId: string): Promise<void> {
    return this.stores.syncedIds.register({ discordId, roomyId });
  }

  async unregisterMapping(discordId: string, roomyId: string): Promise<void> {
    return this.stores.syncedIds.unregister({ discordId, roomyId });
  }

  async listMappings(): Promise<Array<{ discordId: string; roomyId: string }>> {
    return this.stores.syncedIds.list();
  }

  async clearMappings(): Promise<void> {
    return this.stores.syncedIds.clear();
  }

  // === Profile Sync ===

  async getProfileHash(userId: string): Promise<string | undefined> {
    return this.stores.syncedProfiles.get(userId);
  }

  async setProfileHash(userId: string, hash: string): Promise<void> {
    return this.stores.syncedProfiles.put(userId, hash);
  }

  async getRoomyUserProfile(
    did: string,
  ): Promise<RoomyUserProfile | undefined> {
    return this.stores.roomyUserProfiles.get(did);
  }

  async setRoomyUserProfile(
    did: string,
    profile: RoomyUserProfile,
  ): Promise<void> {
    return this.stores.roomyUserProfiles.put(did, profile);
  }

  // === Reactions ===

  async getReaction(key: string): Promise<string | undefined> {
    return this.stores.syncedReactions.get(key);
  }

  async setReaction(key: string, reactionEventId: string): Promise<void> {
    return this.stores.syncedReactions.put(key, reactionEventId);
  }

  async deleteReaction(key: string): Promise<void> {
    return this.stores.syncedReactions.del(key);
  }

  // === Sidebar ===

  async getSidebarHash(): Promise<string | undefined> {
    return this.stores.syncedSidebarHash.get("sidebar");
  }

  async setSidebarHash(hash: string): Promise<void> {
    return this.stores.syncedSidebarHash.put("sidebar", hash);
  }

  // === Room Links ===

  async getRoomLink(key: string): Promise<string | undefined> {
    return this.stores.syncedRoomLinks.get(key);
  }

  async setRoomLink(key: string, linkEventId: string): Promise<void> {
    return this.stores.syncedRoomLinks.put(key, linkEventId);
  }

  // === Message Edits ===

  async getEditInfo(messageId: string): Promise<SyncedEdit | undefined> {
    return this.stores.syncedEdits.get(messageId);
  }

  async setEditInfo(messageId: string, editInfo: SyncedEdit): Promise<void> {
    return this.stores.syncedEdits.put(messageId, editInfo);
  }

  // === Webhooks ===

  async getWebhookToken(channelId: string): Promise<string | undefined> {
    return this.stores.discordWebhookTokens.get(channelId);
  }

  async setWebhookToken(channelId: string, token: string): Promise<void> {
    return this.stores.discordWebhookTokens.put(channelId, token);
  }

  async deleteWebhookToken(channelId: string): Promise<void> {
    return this.stores.discordWebhookTokens.del(channelId);
  }

  // === Message Hashes ===

  async getMessageHashes(): Promise<Record<string, string>> {
    const hashes = await this.stores.discordMessageHashes.get("hashes");
    return hashes || {};
  }

  async setMessageHashes(hashes: Record<string, string>): Promise<void> {
    return this.stores.discordMessageHashes.put("hashes", hashes);
  }

  // === Latest Messages ===

  async getLatestMessage(channelId: string): Promise<string | undefined> {
    return this.stores.discordLatestMessage.get(channelId);
  }

  async setLatestMessage(channelId: string, messageId: string): Promise<void> {
    return this.stores.discordLatestMessage.put(channelId, messageId);
  }
}
