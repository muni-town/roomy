import { StreamDid } from "@roomy/sdk";
import {
  BridgeRepository,
  RoomyUserProfile,
  SyncedEdit,
} from "./BridgeRepository.js";
import { ClassicLevel } from "classic-level";

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
      reactionUsers: ReactionUsers;
      syncedSidebarHash: SyncedSidebarHash;
      syncedRoomLinks: SyncedRoomLinks;
      threadParents: ThreadParents;
      syncedEdits: SyncedEdits;
      discordWebhookTokens: WebhookTokens;
      discordMessageHashes: DiscordMessageHashes;
      discordLatestMessage: LatestMessages;
      leafCursors: LeafCursors;
      registeredBridges: BidirectionalSublevelMap<"guildId", "spaceId">;
      blueskyFetchAttempts: BlueskyFetchAttempts;
    },
  ) {}

  async delete() {
    await this.stores.syncedIds.clear();
    await this.stores.discordLatestMessage.clear();
    await this.stores.discordWebhookTokens.clear();
    await this.stores.syncedProfiles.clear();
    await this.stores.roomyUserProfiles.clear();
    await this.stores.blueskyFetchAttempts.clear();
    await this.stores.syncedReactions.clear();
    await this.stores.reactionUsers.clear();
    await this.stores.syncedSidebarHash.clear();
    await this.stores.syncedRoomLinks.clear();
    await this.stores.threadParents.clear();
    await this.stores.syncedEdits.clear();
    await this.stores.discordMessageHashes.clear();
  }

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

  async getBlueskyFetchAttempt(did: string): Promise<number | undefined> {
    return this.stores.blueskyFetchAttempts.get(did);
  }

  async setBlueskyFetchAttempt(did: string, timestamp: number): Promise<void> {
    return this.stores.blueskyFetchAttempts.put(did, timestamp);
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

  async getReactionUsers(key: string): Promise<Set<string> | undefined> {
    const data = await this.stores.reactionUsers.get(key);
    if (!data) return undefined;
    return new Set(JSON.parse(data));
  }

  async addReactionUser(key: string, userDid: string): Promise<void> {
    const current = await this.stores.reactionUsers.get(key);
    const users = current ? JSON.parse(current) : [];
    if (!users.includes(userDid)) {
      users.push(userDid);
      await this.stores.reactionUsers.put(key, JSON.stringify(users));
    }
  }

  async removeReactionUser(key: string, userDid: string): Promise<void> {
    const current = await this.stores.reactionUsers.get(key);
    if (!current) return;
    const users = JSON.parse(current);
    const filtered = users.filter((u: string) => u !== userDid);
    if (filtered.length > 0) {
      await this.stores.reactionUsers.put(key, JSON.stringify(filtered));
    } else {
      await this.stores.reactionUsers.del(key);
    }
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

  // === Thread Parents ===

  async getThreadParent(threadDiscordId: string): Promise<string | undefined> {
    return this.stores.threadParents.get(threadDiscordId);
  }

  async setThreadParent(threadDiscordId: string, parentDiscordId: string): Promise<void> {
    return this.stores.threadParents.put(threadDiscordId, parentDiscordId);
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

  // === Leaf Cursors ===

  async getCursor(spaceId: string): Promise<number | undefined> {
    return this.stores.leafCursors.get(spaceId);
  }

  async setCursor(spaceId: string, idx: number): Promise<void> {
    return this.stores.leafCursors.put(spaceId, idx);
  }

  // === Registered Bridges (convenience methods) ===

  /**
   * Get the space ID for a guild ID.
   */
  async getSpaceId(guildId: string): Promise<string | undefined> {
    return this.stores.registeredBridges.get_guildId(guildId);
  }

  /**
   * Get the guild ID for a space ID.
   */
  async getGuildId(spaceId: string): Promise<string | undefined> {
    return this.stores.registeredBridges.get_spaceId(spaceId);
  }

  /**
   * Get the last processed index for a space, or 1 if not found.
   * Leaf stream indices are 1-based, so new subscriptions should start at 1.
   */
  async getLastProcessedIdx(spaceId: string): Promise<number> {
    try {
      const idx = await this.stores.leafCursors.get(spaceId);
      return idx ?? 1;
    } catch {
      return 1;
    }
  }
}

export function getRepo(guildId: bigint, spaceId: StreamDid) {
  // Create repository for this guild-space pair
  const syncedIds = syncedIdsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedProfiles = syncedProfilesForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedReactions = syncedReactionsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const reactionUsers = reactionUsersForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedSidebarHash = syncedSidebarHashForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedRoomLinks = syncedRoomLinksForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const threadParents = threadParentsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedEdits = syncedEditsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const discordWebhookTokens = discordWebhookTokensForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const discordMessageHashes = discordMessageHashesForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const roomyUserProfiles = roomyUserProfilesForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const blueskyFetchAttempts = blueskyFetchAttemptsForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const latestMessagesInChannel = discordLatestMessageInChannelForBridge({
    roomySpaceId: spaceId,
    discordGuildId: guildId,
  });

  return new LevelDBBridgeRepository({
    syncedIds,
    syncedProfiles,
    roomyUserProfiles,
    blueskyFetchAttempts,
    syncedReactions,
    reactionUsers,
    syncedSidebarHash,
    syncedRoomLinks,
    threadParents,
    syncedEdits,
    discordWebhookTokens,
    discordMessageHashes,
    discordLatestMessage: latestMessagesInChannel,
    leafCursors,
    registeredBridges,
  });
}

const db = new ClassicLevel(process.env.DATA_DIR || "./data", {
  keyEncoding: "utf8",
  valueEncoding: "json",
});

let openPromise: Promise<void> | undefined;

/**
 * Retry helper with exponential backoff for operations that may fail temporarily.
 * @param operation - Async operation to retry
 * @param context - Description for error messages
 * @param maxRetries - Number of retry attempts (default: 5)
 * @param initialDelay - Initial delay in ms (default: 100)
 * @param maxDelay - Maximum delay in ms (default: 2000)
 * @returns Promise that resolves with operation result or throws after all retries exhausted
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  context: string,
  maxRetries = 5,
  initialDelay = 100,
  maxDelay = 2000,
): Promise<T> {
  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Don't retry if this isn't a lock error
      // Note: abstract-level wraps LEVEL_LOCKED in LEVEL_DATABASE_NOT_OPEN
      const isLockError =
        error.code === "LEVEL_LOCKED" ||
        error.cause?.code === "LEVEL_LOCKED";

      if (!isLockError) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Log retry attempt
      console.warn(
        `⚠️  ${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${delay}ms...`,
      );

      // Wait before retry with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  // All retries exhausted
  throw lastError;
}

/**
 * Ensure the database is open before any operations.
 * This is called automatically by methods that access the database.
 * Uses a promise guard to prevent race conditions when multiple methods
 * call this concurrently during startup.
 *
 * Retry logic handles LEVEL_LOCKED errors which can occur during:
 * - tsx watch restarts (previous process hasn't fully released lock yet)
 * - Rapid process restarts during development
 */
async function ensureDbOpen() {
  if (!db.status || db.status === "closed" || db.status === "closing") {
    if (!openPromise) {
      openPromise = retryWithBackoff(
        () => db.open(),
        "Database open",
        5,  // maxRetries
        100, // initialDelay (ms)
        2000, // maxDelay (ms)
      )
        .then(() => {
          console.log("✅ Database opened successfully");
        })
        .catch((error: any) => {
          if (error.code === "LEVEL_LOCKED") {
            console.error(
              "\n❌ Failed to open database after multiple retries.\n" +
                "The database lock could not be acquired.\n\n" +
                "Possible causes:\n" +
                "  - Another instance of the bridge is running\n" +
                "  - A previous process crashed without closing the database\n" +
                "  - tsx watch restarted too quickly\n\n" +
                "Troubleshooting:\n" +
                "  - Check for running processes: pkill -f 'discord-bridge.*src/index'\n" +
                "  - Check lock file owner: lsof ./data/LOCK\n" +
                "  - Remove stale lock: rm ./data/LOCK (ONLY if no other process is running!)\n",
            );
          }
          throw error;
        })
        .finally(() => {
          openPromise = undefined;
        });

      await openPromise;
    }
  }
}

/**
 * Initialize the database by opening it. Can be called explicitly before any database operations.
 * This is idempotent - safe to call multiple times.
 * Note: Database methods will automatically call this on first use.
 */
export async function initDB() {
  await ensureDbOpen();
  return db;
}

/**
 * Close the database gracefully. Should be called before process exit to ensure
 * proper cleanup and avoid lock issues on restart.
 *
 * This is safe to call multiple times - if database is already closed, it's a no-op.
 */
export async function closeDB() {
  if (!db.status || db.status === "closed") {
    return; // Already closed
  }

  console.log("Closing database...");
  try {
    await db.close();
    console.log("✅ Database closed successfully");
  } catch (error: any) {
    console.error("⚠️  Error closing database:", error.message);
    // Don't throw - we want to continue shutdown even if close fails
  }
}

export type Event<A extends string, B extends string> =
  | ({ type: "register" } & { [K in A | B]: string })
  | ({ type: "unregister" } & { [K in A | B]: string })
  | { type: "clear" };

/** Given two values, atomically creates lookup table entries for each to the other.
 * Allows subscribing to `register`, `unregister` and `clear` events.
 */
export type BidirectionalSublevelMap<A extends string, B extends string> = {
  register: (entry: { [K in A | B]: string }) => Promise<void>;
  unregister: (entry: { [K in A | B]: string }) => Promise<void>;
  subscribe: (onEvent: (event: Event<A, B>) => void) => void;
  list: () => Promise<{ [K in A | B]: string }[]>;
  clear: () => Promise<void>;
  sublevel: any;
} & {
  [K in `get_${A}`]: (b: string) => Promise<string | undefined>;
} & {
  [K in `get_${B}`]: (a: string) => Promise<string | undefined>;
};

function createBidirectionalSublevelMap<A extends string, B extends string>(
  sublevelName: string,
  aname: A,
  bname: B,
): BidirectionalSublevelMap<A, B> {
  const anameLtBname = (aname as string) < (bname as string);
  const sublevel = db.sublevel<string, string>(sublevelName, {
    keyEncoding: "utf8",
    valueEncoding: "utf8",
  });
  const subscribers: ((event: Event<A, B>) => void)[] = [];
  return {
    sublevel,
    /**
     * Sublevel that contains bidirectional mappings from Roomy space to Discord guild ID and
     * vise-versa.
     * */
    // get_aname(value) retrieves 'aname' by looking up the aname-prefixed key
    async [`get_${aname}`](value: string): Promise<string | undefined> {
      return await sublevel.get(aname + "_" + value);
    },
    // get_bname(value) retrieves 'bname' by looking up the bname-prefixed key
    async [`get_${bname}`](value: string): Promise<string | undefined> {
      return await sublevel.get(bname + "_" + value);
    },
    async unregister(entry: { [K in A | B]: string }) {
      await ensureDbOpen();
      const registeredA: string | undefined = await (
        this[`get_${aname}`] as any
      )(entry[bname]);
      const registeredB: string | undefined = await (
        this[`get_${bname}`] as any
      )(entry[aname]);
      if (registeredA != entry[aname] || registeredB != entry[bname]) {
        console.warn(
          `Cannot deregister ${aname}/${bname}: the provided pair isn't registered.`,
        );
        return;
      }
      await sublevel.batch([
        {
          type: "del",
          key: aname + "_" + entry[aname],
        },
        {
          type: "del",
          key: bname + "_" + entry[bname],
        },
      ]);

      for (const sub of subscribers) {
        sub({
          type: "unregister",
          [aname]: entry[aname],
          [bname]: entry[bname],
        });
      }
    },
    async list() {
      await ensureDbOpen();
      const opts = anameLtBname
        ? {
            gt: aname + "_",
            lt: bname + "_",
          }
        : {
            gt: this.aname,
          };
      const iter = sublevel.iterator(opts);
      const list = [];
      for await (const [key, value] of iter) {
        list.push({
          [aname]: key.replace(aname + "_", ""),
          [bname]: value.replace(bname + "_", ""),
        });
      }
      return list;
    },
    async subscribe(onEvent: (event: Event<A, B>) => void) {
      subscribers.push(onEvent);
    },
    async clear() {
      await ensureDbOpen();
      try {
        await sublevel.clear();
        for (const sub of subscribers) {
          sub({ type: "clear" });
        }
      } catch (error: any) {
        // Ignore database errors - if clear fails, tests will create new entries
        console.debug(`Database clear skipped: ${error.message}`);
      }
    },
    async register(entry: { [K in A | B]: string }) {
      await ensureDbOpen();
      const akey = aname + "_" + entry[aname];
      const bkey = bname + "_" + entry[bname];

      // Check for existing registrations (for idempotency)
      const existingA = await sublevel.get(akey);
      const existingB = await sublevel.get(bkey);

      // If both mappings already exist with the same values, this is idempotent - succeed silently
      if (existingA === entry[bname] && existingB === entry[aname]) {
        return; // Already registered with the same values
      }

      // If there's a partial or conflicting registration, update it (for test isolation)
      // This allows tests to re-use the same guild with different spaces
      if (existingA || existingB) {
        // Delete old registrations first
        try {
          await sublevel.batch([
            { type: "del", key: akey },
            { type: "del", key: bkey },
          ]);
        } catch (e) {
          // Ignore deletion errors
        }
      }

      await sublevel.batch([
        {
          key: akey,
          type: "put",
          value: entry[bname],
        },
        {
          key: bkey,
          type: "put",
          value: entry[aname],
        },
      ]);

      for (const sub of subscribers) {
        sub({ type: "register", [aname]: entry[aname], [bname]: entry[bname] });
      }
    },
  } as any;
}

/** 2-way Map between guildIds and spaceIds */
export const registeredBridges = createBidirectionalSublevelMap(
  "registeredBridges",
  "guildId",
  "spaceId",
);

/** Access a KV store for a Discord guild-Roomy space mapping for latest messages.
 *
 * A `discordLatestMessageInChannelForBridge` instance for the
 * specific RoomySpace-DiscordGuild mapping, `latestMessagesInChannel`
 * is returned by `getGuildContext`, and this is used in
 * `messageCreate()` and `backfill()`
 */
export const discordLatestMessageInChannelForBridge = ({
  discordGuildId,
  roomySpaceId,
}: {
  discordGuildId: bigint;
  roomySpaceId: string;
}) =>
  db.sublevel(
    `discordLatestMessageInChannel:${discordGuildId.toString()}:${roomySpaceId}`,
  );

export type LatestMessages = ReturnType<
  typeof discordLatestMessageInChannelForBridge
>;

/** Access a KV store for a Discord guild-Roomy space mapping for webhook tokens.
 *
 * Webhook tokens are created and used in `syncMessageFromRoomyToDiscord()` in the
 * `roomy` watcher, used in `syncDiscordMessageToRoomy()` in `discordBot` and
 * cleared in `slashCommands` where disconnecting the bot is handled.
 */
export const discordWebhookTokensForBridge = ({
  discordGuildId,
  roomySpaceId,
}: {
  discordGuildId: bigint;
  roomySpaceId: string;
}) =>
  db.sublevel(
    `discordWebhookTokens:${discordGuildId.toString()}:${roomySpaceId}`,
  );

export type WebhookTokens = ReturnType<typeof discordWebhookTokensForBridge>;

export type SyncedIds = ReturnType<typeof syncedIdsForBridge>;

/** 2-way Map of IDs between Discord and Roomy.
 * At first I thought this was just for users, but I'm pretty sure it
 * also maps between other entities, like Discord channels - Roomy
 * threads/rooms. For users we shouldn't need it as we now have
 * did-style `discord:12345` IDs which use the ID directly.
 */
export const syncedIdsForBridge = ({
  discordGuildId,
  roomySpaceId,
}: {
  discordGuildId: bigint;
  roomySpaceId: string;
}) => {
  return createBidirectionalSublevelMap(
    `syncedIds:${discordGuildId.toString()}:${roomySpaceId}`,
    "discordId",
    "roomyId",
  );
};

/**
 * Per-space cursor tracking for Leaf event subscriptions.
 * Stores the last processed event index (idx) for each connected space.
 * Used to resume subscriptions from the correct position after restart.
 */
export const leafCursors = db.sublevel<string, number>("leafCursors", {
  valueEncoding: "json",
});

export type LeafCursors = typeof leafCursors;

/**
 * Generic factory for creating per-bridge KV stores.
 * Reduces duplication in store creation by providing a single function
 * that handles the common pattern of creating scoped sublevels.
 *
 * @param storeName - Base name for the store (e.g., "syncedProfiles")
 * @returns Factory function that creates a store for a specific guild-space pair
 */
function createBridgeStoreFactory<TValue = string>(
  storeName: string,
  valueEncoding: "utf8" | "json" = "utf8",
) {
  return ({
    discordGuildId,
    roomySpaceId,
  }: {
    discordGuildId: bigint;
    roomySpaceId: string;
  }) =>
    db.sublevel<string, TValue>(
      `${storeName}:${discordGuildId.toString()}:${roomySpaceId}`,
      {
        keyEncoding: "utf8",
        valueEncoding,
      },
    );
}

/**
 * Per-space profile hash tracking for Discord users.
 * Key: Discord user snowflake
 * Value: profile hash (for change detection)
 */
export const syncedProfilesForBridge =
  createBridgeStoreFactory("syncedProfiles");

export type SyncedProfiles = ReturnType<typeof syncedProfilesForBridge>;

/**
 * Per-space Roomy user profile cache.
 * Key: Roomy user DID
 * Value: User profile data (name, avatar, handle)
 */
export const roomyUserProfilesForBridge =
  createBridgeStoreFactory<RoomyUserProfile>("roomyUserProfiles", "json");

/**
 * Per-space Bluesky fetch attempt tracking.
 * Key: Roomy user DID
 * Value: Unix timestamp in milliseconds of last fetch attempt
 * Used to avoid excessive API calls to Bluesky for profiles that don't exist
 */
export const blueskyFetchAttemptsForBridge = createBridgeStoreFactory<number>(
  "blueskyFetchAttempts",
  "json",
);

export type BlueskyFetchAttempts = ReturnType<
  typeof blueskyFetchAttemptsForBridge
>;

export type RoomyUserProfiles = ReturnType<typeof roomyUserProfilesForBridge>;

/**
 * Per-space reaction tracking for Discord reactions.
 * Key: `${discordMessageId}:${discordUserId}:${emojiKey}` where emojiKey is emoji name or id
 * Value: Roomy reaction event ID (used for removal)
 */
export const syncedReactionsForBridge =
  createBridgeStoreFactory("syncedReactions");

/**
 * Per-space aggregate reaction tracking for Roomy → Discord sync.
 * Key: `${roomyMessageId}:${emoji}`
 * Value: JSON array of user DIDs who have reacted
 * Used to determine if bot should add/remove reaction based on whether any Roomy users have reacted
 */
export const reactionUsersForBridge = createBridgeStoreFactory("reactionUsers");

export type SyncedReactions = ReturnType<typeof syncedReactionsForBridge>;

export type ReactionUsers = ReturnType<typeof reactionUsersForBridge>;

/**
 * Per-space sidebar hash tracking.
 * Key: "sidebar" (single key per space)
 * Value: hash of serialized sidebar structure (for change detection)
 */
export const syncedSidebarHashForBridge =
  createBridgeStoreFactory("syncedSidebarHash");

export type SyncedSidebarHash = ReturnType<typeof syncedSidebarHashForBridge>;

/**
 * Per-space room link tracking.
 * Key: `${parentRoomyId}:${childRoomyId}` (parent→child link)
 * Value: Roomy link event ID
 */
export const syncedRoomLinksForBridge =
  createBridgeStoreFactory("syncedRoomLinks");

export type SyncedRoomLinks = ReturnType<typeof syncedRoomLinksForBridge>;

/**
 * Per-space thread parent tracking.
 * Key: Discord thread snowflake (without "room:" prefix)
 * Value: Parent Discord channel snowflake (without "room:" prefix)
 * Used to resolve the correct channel for webhook creation in threads.
 */
export const threadParentsForBridge =
  createBridgeStoreFactory("threadParents");

export type ThreadParents = ReturnType<typeof threadParentsForBridge>;

export const syncedEditsForBridge = createBridgeStoreFactory<SyncedEdit>(
  "syncedEdits",
  "json",
);

export type SyncedEdits = ReturnType<typeof syncedEditsForBridge>;

/**
 * Per-space Discord message hash tracking for Roomy → Discord sync.
 * Key format: `${truncatedNonce}:${hash}` for webhook messages or `:${hash}` for human messages
 * Value: Discord message ID (snowflake as string)
 * Used for duplicate detection during Roomy → Discord sync (hash-based idempotency)
 */
export const discordMessageHashesForBridge = createBridgeStoreFactory<
  Record<string, string>
>("discordMessageHashes", "json");

export type DiscordMessageHashes = ReturnType<
  typeof discordMessageHashesForBridge
>;
