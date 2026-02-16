/**
 * Service for syncing room structure between Discord and Roomy.
 * Bidirectional sync (stubs for Roomy → Discord).
 *
 * **Roomy → Discord Sync Triggering**:
 * - Channels: Synced when room appears in `updateSidebar` event
 * - Threads: Synced when `createRoomLink` event has `isCreationLink: true`
 * - Rooms: `createRoom` events do NOT trigger sync (only register Discord-origin mappings)
 *
 * This service handles channels, threads, links, and sidebar syncing.
 * Uses SDK operations from @roomy/sdk/package/operations.
 */

import type { BridgeRepository } from "../repositories/index.js";
import type { ConnectedSpace, StreamDid } from "@roomy/sdk";
import {
  newUlid,
  type Ulid,
  type Event,
  type DecodedStreamEvent,
} from "@roomy/sdk";
import type { DiscordBot, ChannelProperties } from "../discord/types.js";
import { computeSidebarHash } from "../utils/hash.js";
import {
  DISCORD_EXTENSION_KEYS,
  extractDiscordOrigin,
  extractDiscordSidebarOrigin,
  extractDiscordRoomLinkOrigin,
} from "../utils/event-extensions.js";
import {
  addRoomySyncMarker,
  extractRoomyRoomId,
} from "../utils/discord-topic.js";

// Import SDK operations from @roomy/sdk/package/operations
import { createRoom, createThread } from "@roomy/sdk/package/operations";
import {
  createChannel as discordCreateChannel,
  fetchChannel as discordFetchChannel,
  type DiscordChannelType,
} from "../discord/operations/channel.js";
import { getRoomKey } from "../utils/room.js";
import type { EventDispatcher } from "../dispatcher.js";
import { Camelize, ChannelTypes, DiscordChannel } from "@discordeno/bot";

/**
 * Cached createRoom event data.
 */
interface CreateRoomInfo {
  name: string;
  hasDiscordOrigin: boolean;
}

/**
 * Cached updateSidebar event data
 */
interface UpdateSidebarInfo {
  categories: {
    id: Ulid;
    name: string;
    children: Ulid[];
  }[];
}

/**
 * Service for syncing room structure between Discord and Roomy.
 */
export class StructureSyncService {
  private createRoomCache = new Map<Ulid, CreateRoomInfo>();
  private updateSidebarCache: UpdateSidebarInfo | null = null;
  private discordCategoryNames = new Map<string, string>(); // <snowflakeString, name>

  constructor(
    private readonly repo: BridgeRepository,
    private readonly spaceId: StreamDid,
    private readonly dispatcher: EventDispatcher,
    private readonly guildId: bigint,
    private readonly bot: DiscordBot,
    private readonly connectedSpace: ConnectedSpace, // Keep for SDK operations
  ) {}

  /**
   * Clear internal caches.
   * Call this between tests to ensure fresh state.
   */
  clearCache(): void {
    this.createRoomCache = new Map();
  }

  /**
   * Handle Discord channel creation.
   * Creates a Roomy room using SDK operation.
   *
   * @param discordChannel - Discord channel to sync
   * @returns The Roomy room ID
   *
   * @example
   * ```ts
   * const roomId = await service.handleDiscordChannelCreate({
   *   id: 123n,
   *   name: "general",
   *   type: 0,
   * });
   * ```
   */
  async handleDiscordChannelCreate(
    discordChannel: ChannelProperties | Camelize<DiscordChannel>,
  ): Promise<string> {
    console.log("handle discord channel create", discordChannel.id);

    // Idempotency check (Discord origin or reprocessing R-origin = LevelsDB)
    const roomKey = getRoomKey(discordChannel.id);
    let roomUlid = await this.repo.getRoomyId(roomKey);

    if (!roomUlid) {
      // Idempotency check (if it's Roomy origin && first time processing, ULID in topic)
      roomUlid = extractRoomyRoomId(discordChannel.topic ?? null) || roomUlid;
      // if we did extract it, set the mapping
      if (roomUlid) await this.repo.registerMapping(roomKey, roomUlid);
    }

    // if at this point we don't have roomUlid, it's Discord-origin and first time handling
    // i.e. we need to create room
    // but if we DO have roomUlid, it could be either R-origin, or D-origin and just already synced

    // D-origin with existing corresponding room, no op
    if (roomUlid) return roomUlid;

    console.log("roomUlid", roomUlid);

    // Call SDK operation (pure function from @roomy/sdk)
    if (!roomUlid) {
      console.log("creating room", discordChannel.id);
      const createRoomEvent = createRoom({
        kind: "space.roomy.channel",
        name: discordChannel.name,
        extensions: {
          [DISCORD_EXTENSION_KEYS.ROOM_ORIGIN]: {
            $type: DISCORD_EXTENSION_KEYS.ROOM_ORIGIN,
            snowflake: discordChannel.id.toString(),
            guildId: this.guildId.toString(),
          },
        },
      });
      roomUlid = createRoomEvent[0]!.id;
      createRoomEvent.forEach((e) => this.dispatcher.toRoomy.push(e));
      // Register mapping
      await this.repo.registerMapping(getRoomKey(discordChannel.id), roomUlid);

      // Verify registration worked
      const verify = await this.repo.getRoomyId(getRoomKey(discordChannel.id));
      if (!verify) {
        console.error(
          `Failed to register mapping for ${getRoomKey(discordChannel.id)} -> ${roomUlid}`,
        );
      }
    }

    return roomUlid;
  }

  /**
   * Handle Discord thread creation.
   * Creates a Roomy thread room and link using SDK operations.
   *
   * @param discordThread - Discord thread to sync
   * @param parentDiscordChannelId - Parent Discord channel ID
   * @returns The Roomy thread room ID
   *
   * @example
   * ```ts
   * const threadId = await service.handleDiscordThreadCreate(
   *   { id: 456n, name: "thread", type: 11, parentId: 123n },
   *   123n
   * );
   * ```
   */
  async handleDiscordThreadCreate(
    discordThread: ChannelProperties | Camelize<DiscordChannel>,
    parentDiscordChannelId: bigint,
  ): Promise<string> {
    console.log("syncing thread D>R", discordThread);
    const threadIdStr = discordThread.id.toString();
    const threadRoomKey = getRoomKey(threadIdStr);

    // Idempotency check for thread
    const existingThread = await this.repo.getRoomyId(threadRoomKey);
    if (existingThread) return existingThread;

    // Ensure parent exists
    const parentRoomKey = getRoomKey(parentDiscordChannelId);
    const parentRoomyId = await this.repo.getRoomyId(parentRoomKey);
    if (!parentRoomyId) {
      throw new Error(`Parent channel ${parentDiscordChannelId} not synced`);
    }

    // Call SDK operation to create thread (handles both room + link creation)
    const createThreadEvents = createThread({
      linkToRoom: parentRoomyId as Ulid,
      name: discordThread.name,
      extensions: {
        [DISCORD_EXTENSION_KEYS.ROOM_ORIGIN]: {
          $type: DISCORD_EXTENSION_KEYS.ROOM_ORIGIN,
          snowflake: threadIdStr,
          guildId: this.guildId.toString(),
        },
      },
    });

    createThreadEvents.forEach((e) => this.dispatcher.toRoomy.push(e));

    const threadId = createThreadEvents[0]!.id;

    // Get the link event ID (it's the second event sent by createThread)
    // createThread sends: createRoom event, then createRoomLink event
    // The createThread SDK operation returns only the thread ID, so we need to infer the link
    // We'll register the link mapping using a key pattern

    // Register link mapping
    const linkKey = `${parentRoomyId}:${threadId}`;
    // The link event ID would be returned by SDK in a real implementation
    // For now, we use the thread ID as a placeholder (this will be tracked by subscription handler)
    await this.repo.setRoomLink(linkKey, threadId);

    // Register thread mapping
    await this.repo.registerMapping(threadRoomKey, threadId);

    return threadId;
  }

  /**
   * Handle full Discord sidebar sync in backfillToRoomy (phase 2).
   * Syncs all channels, categories, threads, and their relationships.
   * Preserves existing Roomy rooms (without discordOrigin) that aren't from Discord.
   *
   * @param channels - All Discord channels
   * @param categories - Discord categories
   *
   * @example
   * ```ts
   * await service.syncFullDiscordSidebar(channels, categories);
   * ```
   */
  async syncFullDiscordSidebar(
    channels: Camelize<DiscordChannel>[],
    categories: Camelize<DiscordChannel>[],
  ): Promise<void> {
    if (!this.updateSidebarCache) {
      console.warn("[SSS.sFDS]: Warning: No Roomy sidebar in cache");
    }

    /** For each Discord category, array of Roomy ULIDs corresponding to Discord children */
    const categoryChildren = new Map<string, Ulid[]>();

    /** Discord channels not in a category */
    const uncategorizedChannels: Ulid[] = [];

    for (const channel of channels) {
      const roomKey = getRoomKey(channel.id);
      let roomyId = await this.repo.getRoomyId(roomKey);

      // If not found, retry a few times (LevelDB might have timing issues)
      if (!roomyId) {
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          roomyId = await this.repo.getRoomyId(roomKey);
          if (roomyId) {
            console.log(
              `Channel ${channel.name} found in repo after retry ${i + 1}`,
            );
            break;
          }
        }
      }

      if (!roomyId) {
        console.warn(
          `Channel ${channel.name} (${channel.id}) not found in repo after retries, skipping in sidebar`,
        );
        continue;
      }

      if (channel.parentId) {
        const parentIdStr = channel.parentId.toString();
        if (!categoryChildren.has(parentIdStr)) {
          categoryChildren.set(parentIdStr, []);
        }
        categoryChildren.get(parentIdStr)!.push(roomyId as Ulid);
      } else {
        uncategorizedChannels.push(roomyId as Ulid);
      }
    }

    console.log("category children", categoryChildren);

    /** New categories array for UpdateSidebar event */
    const sidebarCategories: { id: Ulid; name: string; children: Ulid[] }[] =
      this.updateSidebarCache?.categories || [];

    // Add uncategorized Discord channels to "general" category
    const generalCategory = sidebarCategories.find(
      (c) => c.name === "general",
    ) || {
      id: newUlid() as Ulid,
      name: "general",
      children: [],
    };

    uncategorizedChannels.forEach((ch) => {
      if (!generalCategory.children.includes(ch))
        generalCategory.children.push(ch);
    });

    // Add each Discord category (skip empty ones)
    for (const category of categories) {
      const categoryName = category.name || "Unnamed Category";

      // store name in cache
      this.discordCategoryNames.set(category.id, categoryName);

      const children = categoryChildren.get(category.id.toString()) || [];
      if (children.length > 0) {
        // if a category with this name exists, add children to that one
        const existingCategory = sidebarCategories.find(
          (c) => c.name === category.name,
        );

        // only add if children are not already added
        if (existingCategory)
          children.forEach((ch) => {
            if (!existingCategory.children.includes(ch))
              existingCategory.children.push(ch);
          });
        // otherwise create a new category
        else
          sidebarCategories.push({
            id: newUlid() as Ulid,
            name: category.name || "Unnamed Category",
            children,
          });
      }
    }

    // Hash check for idempotency
    const newHash = computeSidebarHash(sidebarCategories);
    const existingHash = await this.repo.getSidebarHash();
    if (existingHash === newHash) {
      console.log(`Sidebar unchanged (hash: ${newHash}), skipping update`);
      return; // No change
    }

    console.log(
      `Updating sidebar with ${sidebarCategories.length} categories, ${uncategorizedChannels.length} uncategorized Discord, ${categoryChildren.size} Discord categories)`,
    );

    // Send sidebar update event
    const event = {
      id: newUlid(),
      $type: "space.roomy.space.updateSidebar.v1",
      categories: sidebarCategories,
      extensions: {
        [DISCORD_EXTENSION_KEYS.SIDEBAR_ORIGIN]: {
          guildId: this.guildId.toString(),
          sidebarHash: newHash,
        },
      },
    } satisfies Event<"space.roomy.space.updateSidebar.v1">;

    this.dispatcher.toRoomy.push(event);

    // Update hash
    await this.repo.setSidebarHash(newHash);
  }

  /**
   * Handle Roomy room creation (Roomy → Discord sync).
   * Creates a Discord channel if the room doesn't have discordOrigin extension.
   *
   * @param event - Roomy createRoom event
   *
   * @example
   * ```ts
   * await service.handleRoomyRoomCreate(roomyEvent);
   * ```
   */
  async handleRoomyRoomCreate(event: Event): Promise<void> {
    if (!this.bot) {
      console.warn("Bot not available, skipping Roomy → Discord channel sync");
      return;
    }

    // Type assertion to access event properties
    const e = event as any;

    // Skip if this room was synced from Discord (has discordOrigin extension)
    if (DISCORD_EXTENSION_KEYS.ROOM_ORIGIN in (e.extensions || {})) {
      return;
    }

    const roomyRoomId = e.id;
    const roomName = e.name || "unnamed-room";
    const roomKind = e.kind;

    // Only sync channels (not threads, pages, etc.)
    if (roomKind !== "space.roomy.channel") {
      return;
    }

    // Check if we've already synced this room
    const existingDiscordId = await this.repo.getDiscordId(roomyRoomId);
    if (existingDiscordId) {
      // Verify Discord channel still exists
      try {
        const channel = await discordFetchChannel(this.bot, {
          channelId: BigInt(existingDiscordId.replace("room:", "")),
        });
        // Channel exists, check if it has our marker
        if (!extractRoomyRoomId(channel.topic ?? null)) {
          // Channel exists but no marker - add it
          await this.bot.helpers.editChannel(channel.id, {
            topic: addRoomySyncMarker(channel.topic ?? null, roomyRoomId),
          });
        }
        return;
      } catch {
        // Channel doesn't exist, recreate below
      }
    }

    // Create new Discord channel with sync marker
    await this.createDiscordChannelFromRoomy(roomyRoomId, roomName);
  }

  /**
   * Create a Discord channel from a Roomy room.
   * Adds topic marker for idempotency.
   *
   * @param roomyRoomId - Roomy room ULID
   * @param roomName - Room name
   * @returns Discord channel ID (snowflake as string)
   */
  async createDiscordChannelFromRoomy(
    roomyRoomId: Ulid,
    roomName: string,
  ): Promise<string> {
    if (!this.bot) {
      throw new Error("Bot required for Roomy → Discord sync");
    }

    // Build topic with sync marker
    const topic = addRoomySyncMarker(null, roomyRoomId);

    console.log(
      `[StructureSyncService] Creating Discord channel for Roomy room`,
      {
        roomyRoomId,
        roomName,
        guildId: this.guildId.toString(),
        topic,
        botAvailable: !!this.bot,
      },
    );

    // Create Discord channel
    const result = await discordCreateChannel(this.bot, {
      guildId: this.guildId,
      name: roomName,
      type: 0, // GUILD_TEXT
      topic,
    });

    const discordId = result.id.toString();

    // Register mapping with "room:" prefix
    await this.repo.registerMapping(`room:${discordId}`, roomyRoomId);

    console.log(
      `[StructureSyncService] Created Discord channel ${roomName} (${discordId}) for Roomy room ${roomyRoomId}`,
    );

    return discordId;
  }

  /**
   * Handle Roomy sidebar update (Roomy → Discord sync).
   * Creates Discord channels for rooms without discordOrigin extension.
   *
   * @param event - Roomy updateSidebar event
   *
   * @example
   * ```ts
   * await service.handleRoomySidebarUpdate(roomyEvent);
   * ```
   */
  async handleRoomySidebarUpdate(
    sidebar:
      | Event<"space.roomy.space.updateSidebar.v0">
      | Event<"space.roomy.space.updateSidebar.v1">,
  ): Promise<void> {
    // Collect all room IDs from sidebar
    const allRoomIds: Ulid[] = [];
    for (const category of sidebar.categories) {
      allRoomIds.push(...category.children);
    }

    const ensureIds = sidebar.categories.map((c) => ({
      id: "id" in c ? c.id : newUlid(),
      name: c.name,
      children: c.children,
    }));

    console.log("categories", sidebar.categories, ensureIds);

    this.updateSidebarCache = {
      categories: ensureIds,
    };

    console.log("cache", this.updateSidebarCache);

    if (allRoomIds.length === 0) {
      console.log("No rooms in sidebar, skipping sync");
      return;
    }

    // Fetch room names from event stream
    const roomNames = this.createRoomCache;

    // Process each room
    let createdCount = 0;
    let skippedCount = 0;

    for (const roomyRoomId of allRoomIds) {
      // Skip rooms with discordOrigin (synced from Discord)
      const hasOrigin = await this.hasDiscordOrigin(roomyRoomId);
      if (hasOrigin) {
        skippedCount++;
        continue;
      }

      const existingDiscordId = await this.repo.getDiscordId(roomyRoomId);
      const roomName =
        roomNames.get(roomyRoomId)?.name || `roomy-${roomyRoomId.slice(0, 8)}`;

      console.log(
        "[R SB update]: room U:",
        roomyRoomId,
        ", name:",
        roomName,
        ", discordId:",
        existingDiscordId,
      );

      if (existingDiscordId) {
        await this.verifyOrCreateChannelWithName(roomyRoomId, roomName);
      } else {
        await this.createDiscordChannelFromRoomy(roomyRoomId, roomName);
        createdCount++;
      }
    }

    console.log(
      `[Roomy → Discord Sync] Created ${createdCount} channels, skipped ${skippedCount} (from Discord)`,
    );
  }

  /**
   * Check if a Roomy room has Discord origin (was synced from Discord).
   * Uses cached event data for performance.
   */
  private async hasDiscordOrigin(roomyRoomId: Ulid): Promise<boolean> {
    return this.createRoomCache.get(roomyRoomId)?.hasDiscordOrigin ?? false;
  }

  /**
   * Verify a Discord channel exists, has correct name, and has topic marker.
   * Creates or updates channel as needed.
   */
  private async verifyOrCreateChannelWithName(
    roomyRoomId: Ulid,
    roomName: string,
  ): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot required for Roomy → Discord sync");
    }

    const existingDiscordId = await this.repo.getDiscordId(roomyRoomId);
    if (!existingDiscordId) {
      await this.createDiscordChannelFromRoomy(roomyRoomId, roomName);
      return;
    }

    const channelId = existingDiscordId.replace("room:", "");

    try {
      const channel = await discordFetchChannel(this.bot, {
        channelId: BigInt(channelId),
      });

      if (roomName.includes("roomy-")) {
        console.warn(
          "Attempted rename aborted: no name found in cache",
          roomName,
          roomyRoomId,
        );
        return;
      }

      // Check for rename
      if (channel.name !== roomName) {
        await this.handleRoomyRoomRename(roomyRoomId, roomName);
        console.log(`Renamed Discord channel ${channelId} to ${roomName}`);
      }

      // Verify topic marker
      if (!extractRoomyRoomId(channel.topic ?? null)) {
        await this.bot.helpers.editChannel(channel.id, {
          topic: addRoomySyncMarker(channel.topic ?? null, roomyRoomId),
        });
        console.log(`Added sync marker to existing channel ${channelId}`);
      }
    } catch {
      console.warn(`Discord channel ${channelId} not found, recreating...`);
      await this.createDiscordChannelFromRoomy(roomyRoomId, roomName);
    }
  }

  /**
   * Recover Discord channel mappings from Discord topics.
   * Called on bridge startup when local data may be lost.
   */
  async recoverDiscordMappings(): Promise<void> {
    if (!this.bot) {
      console.warn("Bot not available, skipping Discord mapping recovery");
      return;
    }

    try {
      const channels = await this.bot.rest.getChannels(this.guildId.toString());

      let recoveredCount = 0;
      for (const channel of Object.values(channels)) {
        // Check if channel has our topic marker
        const roomyRoomId = extractRoomyRoomId(channel.topic);
        if (roomyRoomId) {
          // This channel was synced from Roomy
          const discordId = channel.id.toString();

          // Check if we already have this mapping
          const existing = await this.repo.getRoomyId(`room:${discordId}`);
          if (!existing || existing !== roomyRoomId) {
            // Register or update the mapping
            await this.repo.registerMapping(`room:${discordId}`, roomyRoomId);
            console.log(`Recovered mapping: ${roomyRoomId} <-> ${discordId}`);
            recoveredCount++;
          }
        }
      }

      console.log(`Recovered ${recoveredCount} Discord mappings`);
    } catch (error) {
      console.error("Error recovering Discord mappings:", error);
      throw error;
    }
  }

  /**
   * Handle Roomy room rename - update Discord channel name.
   */
  async handleRoomyRoomRename(
    roomyRoomId: Ulid,
    newName: string,
  ): Promise<void> {
    const discordId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordId) return; // Not synced to Discord

    const channelId = discordId.replace("room:", "");

    try {
      const channel = await discordFetchChannel(this.bot, {
        channelId: BigInt(channelId),
      });

      if (channel.name !== newName) {
        await this.bot.helpers.editChannel(channel.id, {
          name: newName,
        } as any);
        console.log(`Renamed Discord channel ${channelId} to ${newName}`);
      }
    } catch (error) {
      console.error(`Error renaming Discord channel ${channelId}:`, error);
    }
  }

  /**
   * Handle Roomy sidebar category rename - update Discord category.
   * Note: Discord doesn't support renaming categories directly.
   * This is a placeholder for future implementation.
   */
  async handleRoomyCategoryRename(
    oldName: string,
    newName: string,
  ): Promise<void> {
    if (!this.bot) {
      console.warn(
        "Bot not available, skipping Roomy → Discord category rename sync",
      );
      return;
    }

    // Discord doesn't support renaming categories directly
    // We would need to:
    // 1. Create new category with new name
    // 2. Move all channels to new category
    // 3. Delete old category
    // For now, this is a no-op placeholder
    console.log(`Category rename not implemented: ${oldName} -> ${newName}`);
  }

  /**
   * Handle Roomy thread creation (via createRoomLink with isCreationLink: true).
   * Creates a Discord thread if the parent channel is synced.
   *
   * @param event - Roomy createRoomLink event
   */
  async handleRoomyThreadCreate(event: Event): Promise<void> {
    if (!this.bot) {
      console.warn("Bot not available, skipping Roomy → Discord thread sync");
      return;
    }

    const linkEvent = event as any;
    const threadRoomyId = linkEvent.linkToRoom;
    const parentRoomyId = linkEvent.room;

    // Check if parent has Discord mapping
    const parentDiscordId = await this.repo.getDiscordId(parentRoomyId);
    if (!parentDiscordId) {
      console.warn(
        `[StructureSyncService] Parent room ${parentRoomyId} not synced to Discord, skipping thread sync`,
      );
      return;
    }

    // Check if already synced
    const existingDiscordId = await this.repo.getDiscordId(threadRoomyId);
    if (existingDiscordId) {
      // Verify Discord thread still exists
      try {
        const thread = await discordFetchChannel(this.bot, {
          channelId: BigInt(existingDiscordId.replace("room:", "")),
        });
        // Thread exists, return
        console.log(
          `[StructureSyncService] Thread ${threadRoomyId} already synced to Discord (thread ${thread.id})`,
        );
        return;
      } catch {
        // Thread doesn't exist, recreate below
        console.log(
          `[StructureSyncService] Discord thread for ${threadRoomyId} no longer exists, recreating`,
        );
      }
    }

    // Get thread name from existing cache
    const roomNames = this.createRoomCache;
    const threadName =
      roomNames.get(threadRoomyId)?.name ||
      `roomy-${threadRoomyId.slice(0, 8)}`;

    // Create Discord thread
    await this.createDiscordThreadFromRoomy(
      parentRoomyId,
      threadRoomyId,
      threadName,
    );
  }

  /**
   * Create a Discord thread from a Roomy thread room.
   *
   * @param parentRoomyId - Roomy parent room ULID
   * @param threadRoomyId - Roomy thread room ULID
   * @param threadName - Thread name
   * @returns Discord thread ID (snowflake as string)
   */
  async createDiscordThreadFromRoomy(
    parentRoomyId: Ulid,
    threadRoomyId: Ulid,
    threadName: string,
  ): Promise<string> {
    if (!this.bot) {
      throw new Error("Bot required for Roomy → Discord sync");
    }

    const parentDiscordId = await this.repo.getDiscordId(parentRoomyId);
    if (!parentDiscordId) {
      throw new Error(`Parent room ${parentRoomyId} not synced to Discord`);
    }

    const parentId = BigInt(parentDiscordId.replace("room:", ""));

    console.log(
      `[StructureSyncService] Creating Discord thread ${threadName} under parent ${parentId}`,
    );

    // Create Discord thread using bot.helpers.createChannel with type 11 (PublicThread)
    const threadType = 11 as DiscordChannelType; // GUILD_PUBLIC_THREAD
    const result = await discordCreateChannel(this.bot, {
      guildId: this.guildId,
      name: threadName,
      type: threadType,
      parentId: parentId,
    });

    const discordThreadId = result.id.toString();

    // Register mapping
    await this.repo.registerMapping(`room:${discordThreadId}`, threadRoomyId);

    console.log(
      `[StructureSyncService] Created Discord thread ${threadName} (${discordThreadId}) for Roomy thread ${threadRoomyId}`,
    );

    return discordThreadId;
  }

  /**
   * Handle Roomy room deletion.
   * Deletes the corresponding Discord channel/thread.
   *
   * @param roomyRoomId - Roomy room ID to delete
   */
  async handleRoomyRoomDelete(roomyRoomId: string): Promise<void> {
    // Get Discord channel ID from the Roomy room ID
    const discordId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordId) {
      console.warn(
        `[StructureSyncService] Room ${roomyRoomId} not synced to Discord, skipping delete`,
      );
      return;
    }

    const channelId = BigInt(discordId.replace("room:", ""));

    // TODO: Implement Discord channel deletion
    // Need to:
    // 1. Check if it's a channel or thread
    // 2. Call bot.helpers.deleteChannel() or bot.helpers.deleteThread()
    // 3. Handle permissions and rate limits
    console.warn(
      `[StructureSyncService] Roomy → Discord room deletion not yet implemented for ${roomyRoomId} (Discord: ${channelId})`,
    );
  }

  /**
   * Backfill Discord channels and threads to Roomy. (phase 2)
   * Fetches all channels/threads from Discord guild and syncs them.
   *
   * @returns Number of channels/threads synced
   *
   * @example
   * ```ts
   * const count = await service.backfillToRoomy();
   * ```
   */
  async backfillToRoomy(): Promise<{
    textChannels: Camelize<DiscordChannel[]>;
    publicThreads: Camelize<DiscordChannel[]>;
    syncedCount: number;
  }> {
    let syncedCount = 0;
    let textChannels: Camelize<DiscordChannel[]> = [];
    let publicThreads: Camelize<DiscordChannel[]> = [];

    try {
      const channels = await this.bot.rest.getChannels(this.guildId.toString());

      const categories = channels.filter(
        (c) => c.type === ChannelTypes.GuildCategory,
      );

      textChannels = channels.filter((c) => c.type === ChannelTypes.GuildText);

      for (const channel of textChannels) {
        await this.handleDiscordChannelCreate(channel);
        syncedCount++;
      }

      await this.syncFullDiscordSidebar(textChannels, categories);

      const activeThreads = (
        await this.bot.helpers.getActiveThreads(this.guildId)
      ).threads;
      const archivedThreads = (
        await Promise.all(
          textChannels.map(async (x) => {
            let before;
            let threads: Camelize<DiscordChannel>[] = [];
            while (true) {
              try {
                const resp = await this.bot.helpers.getPublicArchivedThreads(
                  x.id,
                  {
                    before,
                  },
                );
                threads = [...threads, ...(resp.threads as any)];

                if (resp.hasMore) {
                  before = parseInt(
                    resp.threads[resp.threads.length - 1]?.threadMetadata
                      ?.archiveTimestamp || "0",
                  );
                } else {
                  break;
                }
              } catch (e) {
                console.warn(
                  `Error fetching threads for channel ( this might be normal if the bot does not have access to the channel ): ${e}`,
                );
                break;
              }
            }

            return threads;
          }),
        )
      ).flat();

      publicThreads = [
        ...activeThreads,
        ...archivedThreads,
      ] as unknown as Camelize<DiscordChannel[]>; // TODO: fix typing here...
      // static DiscordChannel has different id type, etc from DesiredProperties DiscordChannel

      console.log("found threads", publicThreads);

      for (const thread of publicThreads) {
        if (!thread.parentId) {
          console.warn("Found thread with no parent, skipping");
          continue;
        }
        try {
          await this.handleDiscordThreadCreate(thread, BigInt(thread.parentId));
        } catch (e) {
          console.warn("Error syncing thread", thread, e);
        }
        syncedCount++;
      }

      console.log(
        `[StructureSyncService] Backfilled ${syncedCount} channels/threads to Roomy`,
      );
    } catch (error) {
      console.error(
        "[StructureSyncService] Error backfilling channels:",
        error,
      );
    }

    return { syncedCount, textChannels, publicThreads };
  }

  /**
   * Handle a Roomy event from the subscription stream.
   * Processes structure-related events and syncs them to Discord if needed.
   *
   * @param decoded - The decoded Roomy event
   * @returns true if the event was handled, false otherwise
   */
  async handleRoomyEvent(
    decoded: DecodedStreamEvent,
    batchId: Ulid,
    isLastEvent: boolean,
  ): Promise<boolean> {
    try {
      const { event } = decoded;

      const roomOrigin = extractDiscordOrigin(event);

      // Handle deleteRoom
      if (event.$type === "space.roomy.room.deleteRoom.v0") {
        // Unregister mapping
        const discordId = await this.repo.getDiscordId(event.roomId);
        if (discordId) {
          await this.repo.unregisterMapping(discordId, event.roomId);
        }
        if (isLastEvent && roomOrigin)
          this.dispatcher.toDiscord.push({ batchId, isLastEvent });
        if (roomOrigin) return true; // Handled (Discord origin, no sync back)

        console.log("pushing to Discord", event.id);
        this.dispatcher.toDiscord.push({ decoded, batchId, isLastEvent });

        return true;
      }

      if (event.$type === "space.roomy.room.createRoom.v0") {
        // add name to cache
        this.createRoomCache.set(event.id, {
          name: event.name || `roomy-${event.id.slice(0, 8)}`,
          hasDiscordOrigin: !!roomOrigin,
        });

        if (roomOrigin) {
          // console.log(
          //   "registering roomOrigin room:",
          //   roomOrigin.snowflake,
          //   event.id,
          // );
          await this.repo.registerMapping(
            getRoomKey(roomOrigin.snowflake),
            event.id,
          );
          if (isLastEvent)
            this.dispatcher.toDiscord.push({ batchId, isLastEvent });
          return true; // Handled (Discord origin, no sync back)
        }
      }

      if (event.$type === "space.roomy.link.createRoomLink.v0") {
        const roomLinkData = extractDiscordRoomLinkOrigin(event);
        if (
          roomLinkData &&
          roomLinkData.origin.guildId === this.guildId.toString()
        ) {
          const parentRoomyId = (event as any).room;
          if (parentRoomyId) {
            const linkKey = `${parentRoomyId}:${roomLinkData.linkToRoom}`;
            await this.repo.setRoomLink(linkKey, event.id);
          }
          if (isLastEvent)
            this.dispatcher.toDiscord.push({ batchId, isLastEvent });
          return true; // Handled (Discord origin, no sync back)
        }
      }

      if (
        event.$type === "space.roomy.space.updateSidebar.v0" ||
        event.$type === "space.roomy.space.updateSidebar.v1"
      ) {
        // set immediately for reference
        const sidebarOrigin = extractDiscordSidebarOrigin(event);
        if (
          sidebarOrigin &&
          sidebarOrigin.guildId === this.guildId.toString()
        ) {
          await this.repo.setSidebarHash(sidebarOrigin.sidebarHash);
          // don't return, queue for Discord sync (even if Discord-origin, sidebar should be synced to Discord)
        }

        // if the incoming sidebar is D-origin
        if (!sidebarOrigin) {
          this.updateSidebarCache = {
            categories: event.categories.map((c) => ({
              id: "id" in c ? c.id : (newUlid() as Ulid),
              name: c.name,
              children: c.children,
            })),
          };
        }

        console.log("pushing to Discord", event.id);
        this.dispatcher.toDiscord.push({ decoded, batchId, isLastEvent });

        return true;
      }

      return false;
    } catch (error) {
      console.error(
        `[StructureSyncService] Error handling Roomy event:`,
        error,
      );
      return false;
    }
  }

  /**
   * Sync Roomy-origin structure events to Discord.
   * Called by dispatcher.syncRoomyToDiscord consumer loop.
   */
  async syncToDiscord(decoded: DecodedStreamEvent): Promise<void> {
    const { event } = decoded;
    const e = event as any;

    // Handle updateSidebar (both v0 and v1)
    if (
      event.$type === "space.roomy.space.updateSidebar.v0" ||
      event.$type === "space.roomy.space.updateSidebar.v1"
    ) {
      await this.handleRoomySidebarUpdate(event);
    }
    // Handle createRoomLink (thread creation)
    else if (event.$type === "space.roomy.link.createRoomLink.v0") {
      const isCreationLink = (event as any).isCreationLink === true;
      if (isCreationLink) {
        await this.handleRoomyThreadCreate(event);
      }
    }
    // Handle deleteRoom
    else if (event.$type === "space.roomy.room.deleteRoom.v0") {
      await this.handleRoomyRoomDelete(event.roomId);
    }

    // For 'createRoom' events don't sync yet.
    // Wait for updateSidebar (channels) or createRoomLink with isCreationLink (threads)
  }
}
