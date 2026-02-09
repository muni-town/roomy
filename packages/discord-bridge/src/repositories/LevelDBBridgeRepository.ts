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
      syncedSidebarHash: SyncedSidebarHash;
      syncedRoomLinks: SyncedRoomLinks;
      syncedEdits: SyncedEdits;
      discordWebhookTokens: WebhookTokens;
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
  const syncedSidebarHash = syncedSidebarHashForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });
  const syncedRoomLinks = syncedRoomLinksForBridge({
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
  const latestMessagesInChannel = discordLatestMessageInChannelForBridge({
    roomySpaceId: spaceId,
    discordGuildId: guildId,
  });

  return {
    repo: new LevelDBBridgeRepository({
      syncedIds,
      syncedProfiles,
      roomyUserProfiles,
      syncedReactions,
      syncedSidebarHash,
      syncedRoomLinks,
      syncedEdits,
      discordWebhookTokens,
      discordMessageHashes,
      discordLatestMessage: latestMessagesInChannel,
    }),
    latestMessagesInChannel,
  };
}

const db = new ClassicLevel(process.env.DATA_DIR || "./data", {
  keyEncoding: "utf8",
  valueEncoding: "json",
});

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
      const registeredA: string | undefined = await (
        this[`get_${aname}`] as any
      )(entry[bname]);
      const registeredB: string | undefined = await (
        this[`get_${bname}`] as any
      )(entry[aname]);
      if (registeredA != entry[aname] || registeredB != entry[bname]) {
        throw Error(
          `Cannot deregister ${aname}/${bname}: the provided pair isn't registered.`,
        );
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

export type RoomyUserProfiles = ReturnType<typeof roomyUserProfilesForBridge>;

/**
 * Per-space reaction tracking for Discord reactions.
 * Key: `${discordMessageId}:${discordUserId}:${emojiKey}` where emojiKey is emoji name or id
 * Value: Roomy reaction event ID (used for removal)
 */
export const syncedReactionsForBridge =
  createBridgeStoreFactory("syncedReactions");

export type SyncedReactions = ReturnType<typeof syncedReactionsForBridge>;

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
