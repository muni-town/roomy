/**
 * E2E test setup helpers.
 * Provides Discord bot and Roomy client creation for tests.
 */

import { createBot } from "@discordeno/bot";
import { createDefaultSpaceEvents, type ConnectedSpace, type StreamDid, modules, ConnectedSpace as SDKConnectedSpace, RoomyClient } from "@roomy/sdk";
import { desiredProperties, type ChannelProperties, type DiscordBot } from "../../../src/discord/types.js";
import { isRoomySyncedChannel } from "../../../src/utils/discord-topic.js";
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
  roomyUserProfilesForBridge,
  discordWebhookTokensForBridge,
} from "../../../src/db.js";
import { LevelDBBridgeRepository } from "../../../src/repositories/BridgeRepository.js";
import { createSyncOrchestrator } from "../../../src/services/SyncOrchestrator.js";
import type { SyncOrchestrator } from "../../../src/services/SyncOrchestrator.js";

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
  // Increased delay to handle multiple rapid stream creations in tests
  await new Promise(resolve => setTimeout(resolve, 300));

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

/**
 * Create a SyncOrchestrator for E2E testing.
 *
 * Creates a LevelDBBridgeRepository from the GuildContext stores
 * and uses it to create a configured SyncOrchestrator.
 *
 * @param connectionResult - Result from connectGuildToNewSpace()
 * @param bot - Optional Discord bot instance for reverse sync operations
 * @returns Configured SyncOrchestrator ready for sync operations
 *
 * @example
 * ```ts
 * const result = await connectGuildToNewSpace(roomy, TEST_GUILD_ID, "test");
 * const bot = await createTestBot();
 * const orchestrator = await createSyncOrchestratorForTest(result, bot);
 * await orchestrator.handleDiscordChannelCreate(channel);
 * ```
 */
export function createSyncOrchestratorForTest(
  connectionResult: GuildConnectionResult,
  bot?: DiscordBot,
): SyncOrchestrator {
  const { guildContext, guildId, spaceId } = connectionResult;

  // Create the additional stores needed by LevelDBBridgeRepository
  // that aren't included in GuildContext
  const roomyUserProfiles = roomyUserProfilesForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });

  const discordWebhookTokens = discordWebhookTokensForBridge({
    discordGuildId: guildId,
    roomySpaceId: spaceId,
  });

  // Create the repository wrapper
  const repo = new LevelDBBridgeRepository({
    syncedIds: guildContext.syncedIds,
    syncedProfiles: guildContext.syncedProfiles,
    roomyUserProfiles,
    syncedReactions: guildContext.syncedReactions,
    syncedSidebarHash: guildContext.syncedSidebarHash,
    syncedRoomLinks: guildContext.syncedRoomLinks,
    syncedEdits: guildContext.syncedEdits,
    discordWebhookTokens,
    discordMessageHashes: guildContext.discordMessageHashes,
    discordLatestMessage: guildContext.latestMessagesInChannel,
  });

  // Create and return the orchestrator
  return createSyncOrchestrator({
    repo,
    connectedSpace: guildContext.connectedSpace,
    guildId: guildContext.guildId,
    spaceId: guildContext.spaceId,
    bot,
  });
}

/**
 * Discord channel type constants.
 */
export const DISCORD_CHANNEL_TYPES = {
  GUILD_TEXT: 0,      // Text channel
  GUILD_VOICE: 2,     // Voice channel
  GUILD_CATEGORY: 4,  // Category
  GUILD_NEWS: 5,      // News/announcement channel
  GUILD_NEWS_THREAD: 10, // News thread
  GUILD_PUBLIC_THREAD: 11,  // Public thread
  GUILD_PRIVATE_THREAD: 12, // Private thread
  GUILD_STAGE_VOICE: 13,    // Stage channel
  GUILD_DIRECTORY: 14,      // Directory
  GUILD_FORUM: 15,          // Forum channel
} as const;

/**
 * Check if a Discord channel is a text channel (should sync to Roomy).
 * Excludes voice, forum, and category channels.
 */
export function isTextChannel(channel: ChannelProperties): boolean {
  return (
    channel.type === DISCORD_CHANNEL_TYPES.GUILD_TEXT ||
    channel.type === DISCORD_CHANNEL_TYPES.GUILD_NEWS
  );
}

/**
 * Fetch all text channels from a Discord guild.
 *
 * @param bot - Discord bot instance
 * @param guildId - Guild ID to fetch channels from
 * @returns Array of text channels (excludes voice, forum, category)
 */
export async function getTextChannels(
  bot: DiscordBot,
  guildId: string,
): Promise<ChannelProperties[]> {
  const channels = await bot.rest.getChannels(guildId);

  const textChannels: ChannelProperties[] = [];
  for (const channel of channels.values()) {
    if (isTextChannel(channel)) {
      textChannels.push(channel as ChannelProperties);
    }
  }

  return textChannels;
}

/**
 * Fetch all categories from a Discord guild.
 *
 * @param bot - Discord bot instance
 * @param guildId - Guild ID to fetch channels from
 * @returns Array of category channels
 */
export async function getCategories(
  bot: DiscordBot,
  guildId: string,
): Promise<ChannelProperties[]> {
  const channels = await bot.rest.getChannels(guildId);

  const categories: ChannelProperties[] = [];
  for (const channel of channels.values()) {
    if (channel.type === DISCORD_CHANNEL_TYPES.GUILD_CATEGORY) {
      categories.push(channel as ChannelProperties);
    }
  }

  return categories;
}

/**
 * Delete all channels in a guild that have the Roomy sync marker.
 *
 * This is useful for cleaning up test environments between test runs.
 * Channels are identified by the [Synced from Roomy: <ULID>] marker in their topic.
 *
 * @param bot - Discord bot instance
 * @param guildId - Guild ID to clean up
 * @returns Number of channels deleted
 *
 * @example
 * ```ts
 * const bot = await createTestBot();
 * const deletedCount = await cleanupRoomySyncedChannels(bot, TEST_GUILD_ID);
 * console.log(`Cleaned up ${deletedCount} test channels`);
 * ```
 */
export async function cleanupRoomySyncedChannels(
  bot: DiscordBot,
  guildId: string,
): Promise<number> {
  const channels = await bot.rest.getChannels(guildId);
  let deletedCount = 0;

  // Collect channels to delete (we can't delete while iterating)
  const toDelete: bigint[] = [];
  for (const channel of channels) {
    // Only delete channels (not categories or voice channels)
    if (isTextChannel(channel)) {
      // Check if this channel has the Roomy sync marker
      if (isRoomySyncedChannel(channel.topic ?? null)) {
        toDelete.push(BigInt(channel.id));
      }
    }
  }

  // Delete the channels
  for (const channelId of toDelete) {
    try {
      await bot.rest.deleteChannel(channelId);
      deletedCount++;
    } catch (error) {
      console.warn(`Failed to delete channel ${channelId}:`, error);
    }
  }

  return deletedCount;
}

/**
 * Cleanup function: Delete all messages from Roomy-synced channels.
 *
 * This preserves the channels but removes all test messages.
 * Useful for cleaning up test messages without deleting test channels.
 *
 * @param bot - Discord bot instance
 * @param guildId - Discord guild ID (usually TEST_GUILD_ID)
 * @returns Number of messages deleted
 *
 * @example
 * ```ts
 * const bot = await createTestBot();
 * const deletedCount = await cleanupTestMessages(bot, TEST_GUILD_ID);
 * console.log(`Cleaned up ${deletedCount} test messages`);
 * ```
 */
export async function cleanupTestMessages(
  bot: DiscordBot,
  guildId: string,
): Promise<number> {
  const channels = await bot.rest.getChannels(guildId);
  let deletedMessages = 0;

  console.log(`\n📋 Found ${channels.length} total channels`);

  for (const channel of channels) {
    // Only clean Roomy-synced text channels
    if (!isTextChannel(channel)) {
      continue;
    }

    const hasRoomyMarker = isRoomySyncedChannel(channel.topic ?? null);
    if (!hasRoomyMarker) {
      continue;
    }

    console.log(`\n📝 Processing #${channel.name} (${channel.id})`);
    console.log(`   Topic: "${channel.topic?.slice(0, 50)}..."`);

    try {
      // Fetch messages (Discord API returns up to 100 at a time)
      const messages = await bot.rest.getMessages(channel.id, { limit: 100 });
      console.log(`   Found ${messages.length} messages`);

      // Count webhook vs regular messages
      const webhookMessageCount = messages.filter(m => m.webhookId).length;
      const regularMessageCount = messages.length - webhookMessageCount;
      console.log(`   → ${webhookMessageCount} webhook messages, ${regularMessageCount} regular messages`);

      // Delete all messages - webhook messages need special handling
      for (const message of messages) {
        const isWebhook = !!message.webhookId;

        try {
          if (isWebhook && message.webhookId) {
            // Webhook messages must be deleted by the webhook
            // First, get the webhook to retrieve its token
            const webhooks = await bot.rest.getChannelWebhooks(channel.id);
            const webhookIdStr = message.webhookId.toString();
            const webhook = webhooks.find(w => w.id === webhookIdStr);

            if (webhook && webhook.token) {
              await bot.helpers.deleteWebhookMessage(
                webhook.id,
                webhook.token,
                message.id,
              );
              deletedMessages++;
            } else {
              console.warn(`  ❌ Webhook ${message.webhookId} not found, skipping message ${message.id}`);
            }
          } else {
            // Regular bot message - can be deleted directly
            await bot.helpers.deleteMessage(channel.id, message.id);
            deletedMessages++;
          }
        } catch (error: any) {
          // Log all errors for debugging
          const errorType = error?.code || error?.metadata?.code || "UNKNOWN";
          console.warn(`  ❌ Failed to delete ${isWebhook ? "webhook" : "regular"} message ${message.id} (code: ${errorType}):`, error.message);
        }
      }

      console.log(`   ✅ Deleted ${deletedMessages} messages`);
    } catch (error) {
      console.error(`  ❌ Failed to clean messages from channel ${channel.id}:`, error);
    }
  }

  console.log(`\n📊 Total messages deleted: ${deletedMessages}\n`);
  return deletedMessages;
}

/**
 * Cleanup function: Delete all webhook messages from ALL text channels in a guild.
 *
 * This is more aggressive than cleanupTestMessages - it targets webhook messages
 * in all text channels, not just Roomy-synced channels. Useful for cleaning up
 * webhook messages created during reverse sync tests.
 *
 * @param bot - Discord bot instance
 * @param guildId - Discord guild ID (usually TEST_GUILD_ID)
 * @returns Number of webhook messages deleted
 *
 * @example
 * ```ts
 * const bot = await createTestBot();
 * const deletedCount = await cleanupWebhookMessages(bot, TEST_GUILD_ID);
 * console.log(`Cleaned up ${deletedCount} webhook messages`);
 * ```
 */
export async function cleanupWebhookMessages(
  bot: DiscordBot,
  guildId: string,
): Promise<number> {
  const channels = await bot.rest.getChannels(guildId);
  let deletedMessages = 0;
  let totalWebhookMessages = 0;

  console.log(`\n📋 Found ${channels.length} total channels`);

  for (const channel of channels) {
    // Only process text channels (any text channel, not just Roomy-synced)
    if (!isTextChannel(channel)) {
      continue;
    }

    console.log(`\n📝 Processing #${channel.name} (${channel.id})`);

    try {
      // Fetch messages (Discord API returns up to 100 at a time)
      const messages = await bot.rest.getMessages(channel.id, { limit: 100 });

      // Filter only webhook messages
      const webhookMessages = messages.filter(m => m.webhookId);
      totalWebhookMessages += webhookMessages.length;
      console.log(`   Found ${messages.length} total messages, ${webhookMessages.length} webhook messages`);

      if (webhookMessages.length === 0) {
        console.log(`   ℹ️  No webhook messages to delete`);
        continue;
      }

      // Delete webhook messages
      for (const message of webhookMessages) {
        try {
          // Try direct deletion first - bot with MANAGE_MESSAGES can delete any message
          // IDs from Discord API are already Bigints
          await bot.helpers.deleteMessage(channel.id, message.id);
          deletedMessages++;
          // Rate limiting: small delay between deletions
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error: any) {
          // If direct deletion fails, try webhook-based deletion
          const errorDetails = error?.message || String(error);
          console.warn(`  ⚠️  Direct deletion failed for ${message.id}: ${errorDetails}`);

          try {
            // Webhook messages must be deleted by the webhook
            // First, get the webhook to retrieve its token
            const webhooks = await bot.rest.getChannelWebhooks(channel.id);
            const webhookIdStr = message.webhookId?.toString();
            const webhook = webhookIdStr ? webhooks.find(w => w.id === webhookIdStr) : undefined;

            if (webhook && webhook.token && message.webhookId) {
              await bot.helpers.deleteWebhookMessage(
                webhook.id,
                webhook.token,
                message.id,
              );
              deletedMessages++;
              // Rate limiting: small delay between deletions
              await new Promise(resolve => setTimeout(resolve, 200));
            } else {
              console.warn(`  ❌ Webhook ${message.webhookId} not found, skipping message ${message.id}`);
            }
          } catch (webhookError: any) {
            const webhookErrorDetails = webhookError?.message || String(webhookError);
            console.warn(`  ❌ Webhook deletion also failed for ${message.id}: ${webhookErrorDetails}`);
          }
        }
      }

      console.log(`   ✅ Deleted ${deletedMessages} webhook messages`);
    } catch (error) {
      console.error(`  ❌ Failed to clean webhook messages from channel ${channel.id}:`, error);
    }
  }

  console.log(`\n📊 Total webhook messages deleted: ${deletedMessages} of ${totalWebhookMessages}\n`);

  // Fail if we couldn't delete webhook messages
  if (totalWebhookMessages > 0 && deletedMessages < totalWebhookMessages) {
    const orphaned = totalWebhookMessages - deletedMessages;
    throw new Error(
      `Failed to delete ${orphaned} webhook messages. ` +
      `The webhooks that created these messages may have been deleted. ` +
      `To prevent this in the future, use safeDeleteWebhook() to delete ` +
      `webhook messages before deleting the webhook itself.`
    );
  }

  return deletedMessages;
}

/**
 * Cleanup function: Delete all bot messages from ALL text channels in a guild.
 *
 * This targets regular bot messages (not webhook messages) from all text channels.
 * Useful for cleaning up test messages created by the bot during testing.
 *
 * @param bot - Discord bot instance
 * @param guildId - Discord guild ID (usually TEST_GUILD_ID)
 * @returns Number of bot messages deleted
 *
 * @example
 * ```ts
 * const bot = await createTestBot();
 * const deletedCount = await cleanupBotMessages(bot, TEST_GUILD_ID);
 * console.log(`Cleaned up ${deletedCount} bot messages`);
 * ```
 */
export async function cleanupBotMessages(
  bot: DiscordBot,
  guildId: string,
): Promise<number> {
  const channels = await bot.rest.getChannels(guildId);
  let deletedMessages = 0;
  let totalBotMessages = 0;

  console.log(`\n📋 Found ${channels.length} total channels`);

  for (const channel of channels) {
    // Only process text channels
    if (!isTextChannel(channel)) {
      continue;
    }

    console.log(`\n📝 Processing #${channel.name} (${channel.id})`);

    try {
      // Fetch messages
      const messages = await bot.rest.getMessages(channel.id, { limit: 100 });

      // Filter bot messages (not webhook messages, and author.bot is true)
      const botMessages = messages.filter(m => !m.webhookId && m.author?.bot);
      totalBotMessages += botMessages.length;
      console.log(`   Found ${messages.length} total messages, ${botMessages.length} bot messages`);

      if (botMessages.length === 0) {
        console.log(`   ℹ️  No bot messages to delete`);
        continue;
      }

      // Delete bot messages
      for (const message of botMessages) {
        try {
          await bot.helpers.deleteMessage(channel.id, message.id);
          deletedMessages++;
          // Rate limiting: small delay between deletions
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error: any) {
          const errorDetails = error?.message || String(error);
          console.warn(`  ❌ Failed to delete bot message ${message.id}: ${errorDetails}`);
        }
      }

      console.log(`   ✅ Deleted ${deletedMessages} bot messages`);
    } catch (error) {
      console.error(`  ❌ Failed to clean bot messages from channel ${channel.id}:`, error);
    }
  }

  console.log(`\n📊 Total bot messages deleted: ${deletedMessages} of ${totalBotMessages}\n`);

  // Fail if we couldn't delete all bot messages
  if (totalBotMessages > 0 && deletedMessages < totalBotMessages) {
    const orphaned = totalBotMessages - deletedMessages;
    throw new Error(
      `Failed to delete ${orphaned} bot messages. ` +
      `Check bot permissions and ensure MANAGE_MESSAGES is granted.`
    );
  }

  return deletedMessages;
}

/**
 * Safely delete a webhook by first deleting all its messages, then the webhook itself.
 *
 * This prevents orphaned webhook messages that can't be cleaned up later.
 * Webhook messages must be deleted using the webhook's token before the webhook is deleted.
 *
 * @param bot - Discord bot instance
 * @param channelId - Channel ID where the webhook is configured
 * @param webhookId - Webhook ID to delete
 * @returns Number of messages deleted before webhook deletion
 *
 * @example
 * ```ts
 * const messagesDeleted = await safeDeleteWebhook(bot, channelId, webhookId);
 * console.log(`Deleted webhook and ${messagesDeleted} messages`);
 * ```
 */
export async function safeDeleteWebhook(
  bot: DiscordBot,
  channelId: bigint,
  webhookId: bigint,
): Promise<number> {
  let messagesDeleted = 0;

  try {
    // Get the webhook to retrieve its token
    const webhooks = await bot.rest.getChannelWebhooks(channelId);
    const webhook = webhooks.find(w => BigInt(w.id) === webhookId);

    if (!webhook) {
      console.warn(`⚠️  Webhook ${webhookId} not found, may have been deleted already`);
      return 0;
    }

    if (!webhook.token) {
      console.warn(`⚠️  Webhook ${webhookId} does not have a token, cannot delete messages`);
      return 0;
    }

    console.log(`🔗 Cleaning up webhook ${webhookId} before deletion...`);

    // Fetch recent messages from the channel
    const messages = await bot.rest.getMessages(channelId, { limit: 100 });

    // Find and delete messages created by this webhook
    const webhookMessages = messages.filter(m => BigInt(m.webhookId || 0) === webhookId);

    if (webhookMessages.length > 0) {
      console.log(`   Found ${webhookMessages.length} messages from this webhook`);

      for (const message of webhookMessages) {
        try {
          await bot.helpers.deleteWebhookMessage(
            webhookId,
            webhook.token,
            message.id,
          );
          messagesDeleted++;
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.warn(`   ⚠️  Failed to delete message ${message.id}:`, error);
        }
      }

      console.log(`   ✅ Deleted ${messagesDeleted} webhook messages`);
    } else {
      console.log(`   ℹ️  No messages to clean up`);
    }

    // Now delete the webhook itself
    await bot.helpers.deleteWebhook(webhookId);
    console.log(`   ✅ Deleted webhook ${webhookId}`);

    return messagesDeleted;
  } catch (error) {
    console.error(`❌ Failed to safely delete webhook ${webhookId}:`, error);
    return messagesDeleted;
  }
}
