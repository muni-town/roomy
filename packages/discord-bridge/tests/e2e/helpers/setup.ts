/**
 * E2E test setup helpers.
 * Provides Discord bot and Roomy client creation for tests.
 */

import { createBot } from "@discordeno/bot";
import { createDefaultSpaceEvents, type ConnectedSpace, type StreamDid, modules, ConnectedSpace as SDKConnectedSpace, RoomyClient } from "@roomy/sdk";
import { desiredProperties } from "../../../src/discord/types.js";
import { DISCORD_TOKEN, LEAF_URL, LEAF_SERVER_DID, ATPROTO_BRIDGE_DID, ATPROTO_BRIDGE_APP_PASSWORD } from "../../../src/env.js";
import { registeredBridges } from "../../../src/db.js";
import { connectedSpaces, initRoomyClient, getRoomyClient as getBridgeRoomyClient } from "../../../src/roomy/client.js";
import type { GuildContext } from "../../../src/types.js";
import {
  syncedIdsForBridge,
  syncedProfilesForBridge,
  syncedReactionsForBridge,
  syncedSidebarHashForBridge,
  syncedRoomLinksForBridge,
  syncedEditsForBridge,
  discordMessageHashesForBridge,
  discordLatestMessageInChannelForBridge,
} from "../../../src/db.js";

/**
 * Environment variables for E2E tests.
 */
export interface TestEnv {
  /** Discord bot token */
  discordToken: string;
  /** Test guild ID */
  testGuildId: string;
  /** Leaf server URL */
  leafUrl: string;
  /** Leaf server DID */
  leafServerDid: string;
  /** Bridge DID for Roomy auth */
  bridgeDid: string;
  /** Bridge app password for Roomy auth */
  bridgeAppPassword: string;
}

/**
 * Get test environment variables.
 * Throws if required variables are missing.
 */
export function getTestEnv(): TestEnv {
  const testGuildId = process.env.TEST_GUILD_ID;
  if (!testGuildId) {
    throw new Error("TEST_GUILD_ID environment variable not set");
  }

  return {
    discordToken: DISCORD_TOKEN,
    testGuildId,
    leafUrl: LEAF_URL,
    leafServerDid: LEAF_SERVER_DID,
    bridgeDid: ATPROTO_BRIDGE_DID,
    bridgeAppPassword: ATPROTO_BRIDGE_APP_PASSWORD,
  };
}

/**
 * Create a Discord bot for testing.
 * Uses REST API only (no gateway connection needed for most operations).
 */
export async function createTestBot() {
  const env = getTestEnv();

  const bot = await createBot({
    token: env.discordToken,
    desiredProperties,
  });

  return bot;
}

/**
 * Initialize the Roomy client for E2E tests.
 * This should be called once in a beforeAll hook.
 * Reuses the bridge's existing client infrastructure.
 */
export async function initE2ERoomyClient(): Promise<RoomyClient> {
  return initRoomyClient();
}

/**
 * Get the initialized Roomy client.
 */
export function getRoomyClient(): RoomyClient {
  return getBridgeRoomyClient();
}

/**
 * Result of connecting a guild to a space.
 */
export interface GuildConnectionResult {
  /** The space ID */
  spaceId: StreamDid;
  /** The guild ID */
  guildId: string;
  /** The connected space instance */
  connectedSpace: ConnectedSpace;
  /** The guild context for sync operations */
  guildContext: GuildContext;
}

/**
 * Connect a Discord guild to a new Roomy space (reset any existing connection).
 *
 * This function:
 * 1. Creates a new space with default structure
 * 2. Unregisters any existing bridge for this guild
 * 3. Registers the new guild -> space mapping
 * 4. Tracks the ConnectedSpace for bridge operations
 * 5. Returns the GuildContext for sync operations
 *
 * @param roomy - Roomy client (from getRoomyClient())
 * @param guildId - Discord guild ID (as string)
 * @param spaceName - Name for the new space
 * @returns Connection result with space ID and guild context
 */
export async function connectGuildToNewSpace(
  roomy: RoomyClient,
  guildId: string,
  spaceName: string,
): Promise<GuildConnectionResult> {
  // 1. Create a new space stream
  const space = await SDKConnectedSpace.create(
    {
      client: roomy,
      module: modules.space,
    },
    ATPROTO_BRIDGE_DID as `did:${string}:${string}`,
  );

  const spaceId = space.streamDid;

  // 2. Send default space events (lobby channel + sidebar)
  const events = createDefaultSpaceEvents({ name: spaceName });
  await space.sendEvents(events);

  // Wait for events to be materialized in Leaf before continuing
  await new Promise(resolve => setTimeout(resolve, 100));

  // 3. Aggressive cleanup of any existing registrations for this guild
  // This handles cases where previous tests may have left partial state
  try {
    const existingSpaceForGuild = await registeredBridges.get_spaceId(guildId);
    if (existingSpaceForGuild) {
      await registeredBridges.unregister({ guildId, spaceId: existingSpaceForGuild });
      connectedSpaces.delete(existingSpaceForGuild);
    }
  } catch (e) {
    // If unregister fails (e.g., partial registration), clear both keys aggressively
    try {
      const existingSpaceForGuild = await registeredBridges.get_spaceId(guildId);
      await registeredBridges.sublevel.batch([
        { type: 'del', key: `guildId_${guildId}` },
        { type: 'del', key: existingSpaceForGuild ? `spaceId_${existingSpaceForGuild}` : `spaceId_${spaceId}` },
      ]);
      if (existingSpaceForGuild) {
        connectedSpaces.delete(existingSpaceForGuild);
      }
    } catch {
      // Ignore deletion errors
    }
  }

  // Also check if our new spaceId happens to be registered to another guild (unlikely)
  try {
    const existingGuildForNewSpace = await registeredBridges.get_guildId(spaceId);
    if (existingGuildForNewSpace) {
      await registeredBridges.sublevel.del(`spaceId_${spaceId}`);
    }
  } catch {
    // Ignore errors
  }

  // Delay to ensure LevelDB deletes are flushed before registering
  await new Promise(resolve => setTimeout(resolve, 50));

  // 4. Register the new guild -> space mapping
  await registeredBridges.register({ guildId, spaceId });

  // Small delay to ensure LevelDB write is flushed
  await new Promise(resolve => setTimeout(resolve, 10));

  // 5. Track the ConnectedSpace (needed for getGuildContext to work)
  connectedSpaces.set(spaceId, space);

  // 6. Create the GuildContext that sync operations need
  const guildIdBigInt = BigInt(guildId);
  const guildContext: GuildContext = {
    guildId: guildIdBigInt,
    spaceId: spaceId,
    syncedIds: syncedIdsForBridge({
      discordGuildId: guildIdBigInt,
      roomySpaceId: spaceId,
    }),
    latestMessagesInChannel: discordLatestMessageInChannelForBridge({
      discordGuildId: guildIdBigInt,
      roomySpaceId: spaceId,
    }),
    syncedReactions: syncedReactionsForBridge({
      discordGuildId: guildIdBigInt,
      roomySpaceId: spaceId,
    }),
    syncedRoomLinks: syncedRoomLinksForBridge({
      discordGuildId: guildIdBigInt,
      roomySpaceId: spaceId,
    }),
    syncedProfiles: syncedProfilesForBridge({
      discordGuildId: guildIdBigInt,
      roomySpaceId: spaceId,
    }),
    syncedSidebarHash: syncedSidebarHashForBridge({
      discordGuildId: guildIdBigInt,
      roomySpaceId: spaceId,
    }),
    syncedEdits: syncedEditsForBridge({
      discordGuildId: guildIdBigInt,
      roomySpaceId: spaceId,
    }),
    discordMessageHashes: discordMessageHashesForBridge({
      discordGuildId: guildIdBigInt,
      roomySpaceId: spaceId,
    }),
    connectedSpace: space,
  };

  return {
    spaceId,
    guildId,
    connectedSpace: space,
    guildContext,
  };
}

/**
 * Query helper for Roomy spaces.
 */
export class RoomyQueryHelper {
  constructor(private client: RoomyClient) {}

  /**
   * Query the event stream for a space.
   */
  async queryEvents(spaceId: StreamDid, params?: { start?: number; limit?: number }) {
    return this.client.leaf.query(spaceId, {
      name: "events",
      params: {
        start: params?.start ?? 0,
        limit: params?.limit ?? 100,
      },
    });
  }

  /**
   * Query space info.
   */
  async querySpaceInfo(spaceId: StreamDid) {
    return this.client.leaf.query(spaceId, {
      name: "stream_info",
      params: {},
    });
  }

  /**
   * Query metadata events.
   */
  async queryMetadata(spaceId: StreamDid, params?: { start?: number; limit?: number }) {
    return this.client.leaf.query(spaceId, {
      name: "metadata",
      params: {
        start: params?.start ?? 0,
        limit: params?.limit ?? 100,
      },
    });
  }

  /**
   * Query room events.
   */
  async queryRoomEvents(spaceId: StreamDid, roomId: string, params?: { end?: number; limit?: number }) {
    return this.client.leaf.query(spaceId, {
      name: "room",
      params: {
        room: roomId,
        end: params?.end,
        limit: params?.limit ?? 100,
      },
    });
  }
}

/**
 * Create a query helper for the initialized Roomy client.
 */
export function createQueryHelper(): RoomyQueryHelper {
  return new RoomyQueryHelper(getRoomyClient());
}
