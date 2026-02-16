/**
 * Repository interface for Discord ↔ Roomy bridge data access.
 * Abstracts database operations to enable testing with mock implementations.
 */

/**
 * Roomy user profile data.
 * Stored when we see an updateProfile event from Roomy users.
 */
export interface RoomyUserProfile {
  name: string;
  avatar: string | null;
  handle?: string;
}

/**
 * Message edit tracking information
 */
export type SyncedEdit = {
  editedTimestamp: number;
  contentHash: string;
};

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
  /** Disconnect Roomy space from Guild. Remove all data specific to the mapping. */
  delete(): Promise<void>;
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

  /**
   * Get the timestamp of the last Bluesky profile fetch attempt for a DID.
   * Used to avoid excessive API calls to Bluesky.
   * @returns Unix timestamp in milliseconds, or undefined if never fetched
   */
  getBlueskyFetchAttempt(did: string): Promise<number | undefined>;

  /**
   * Record a Bluesky profile fetch attempt for a DID.
   * @param did - User DID to record fetch attempt for
   * @param timestamp - Unix timestamp in milliseconds of the fetch attempt
   */
  setBlueskyFetchAttempt(did: string, timestamp: number): Promise<void>;

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

  /**
   * Get all users who have reacted with a specific emoji on a message.
   * @param key - `${roomyMessageId}:${emoji}`
   * @returns Set of user DIDs, or undefined if no reactions
   */
  getReactionUsers(key: string): Promise<Set<string> | undefined>;

  /**
   * Add a user to the reaction set for a message/emoji.
   * @param key - `${roomyMessageId}:${emoji}`
   * @param userDid - User DID to add
   */
  addReactionUser(key: string, userDid: string): Promise<void>;

  /**
   * Remove a user from the reaction set for a message/emoji.
   * @param key - `${roomyMessageId}:${emoji}`
   * @param userDid - User DID to remove
   */
  removeReactionUser(key: string, userDid: string): Promise<void>;

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

  // === Thread Parents ===

  /**
   * Get the parent Discord channel ID for a Discord thread.
   * Used to resolve the correct channel for webhook creation,
   * since Discord requires webhooks to be created on the parent channel.
   * @param threadDiscordId - Discord thread snowflake (without "room:" prefix)
   * @returns Parent Discord channel snowflake (without "room:" prefix), or undefined
   */
  getThreadParent(threadDiscordId: string): Promise<string | undefined>;

  /**
   * Store the parent Discord channel ID for a Discord thread.
   * @param threadDiscordId - Discord thread snowflake (without "room:" prefix)
   * @param parentDiscordId - Parent Discord channel snowflake (without "room:" prefix)
   */
  setThreadParent(threadDiscordId: string, parentDiscordId: string): Promise<void>;

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

  // === Leaf Cursors ===

  /**
   * Get the last processed event index for a space.
   * Used to resume subscriptions from the correct position.
   */
  getCursor(spaceId: string): Promise<number | undefined>;

  /**
   * Set the last processed event index for a space.
   */
  setCursor(spaceId: string, idx: number): Promise<void>;

  /**
   * Get the last processed index for a space, or 1 if not found.
   * Leaf stream indices are 1-based, so new subscriptions should start at 1.
   */
  getLastProcessedIdx(spaceId: string): Promise<number>;

  // === Registered Bridges ===

  /**
   * Get the space ID for a guild ID.
   */
  getSpaceId(guildId: string): Promise<string | undefined>;

  /**
   * Get the guild ID for a space ID.
   */
  getGuildId(spaceId: string): Promise<string | undefined>;
}
