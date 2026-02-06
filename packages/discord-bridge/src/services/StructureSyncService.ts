/**
 * Service for syncing room structure between Discord and Roomy.
 * Bidirectional sync (stubs for Roomy → Discord).
 *
 * This service handles channels, threads, links, and sidebar syncing.
 * Uses SDK operations from @roomy/sdk/package/operations.
 */

import type { BridgeRepository } from "../repositories/index.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid, type Ulid, type Event } from "@roomy/sdk";
import type { DiscordBot, ChannelProperties } from "../discord/types.js";
import { computeSidebarHash } from "../utils/hash.js";
import { DISCORD_EXTENSION_KEYS } from "../roomy/subscription.js";
import { addRoomySyncMarker, extractRoomyRoomId } from "../utils/discord-topic.js";

// Import SDK operations from @roomy/sdk/package/operations
import { createRoom, createThread } from "@roomy/sdk/package/operations";
import { createChannel as discordCreateChannel, fetchChannel as discordFetchChannel } from "../discord/operations/channel.js";

/**
 * Service for syncing room structure between Discord and Roomy.
 */
export class StructureSyncService {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly connectedSpace: ConnectedSpace,
    private readonly guildId: bigint,
    private readonly spaceId: string,
    private readonly bot?: DiscordBot,
  ) {}

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
  async handleDiscordChannelCreate(discordChannel: ChannelProperties): Promise<string> {
    // Idempotency check (use room: prefix for channels/threads)
    const channelIdStr = discordChannel.id.toString();
    const roomKey = `room:${channelIdStr}`;
    const existing = await this.repo.getRoomyId(roomKey);
    if (existing) return existing;

    // Call SDK operation (pure function from @roomy/sdk)
    const result = await createRoom(this.connectedSpace, {
      kind: "space.roomy.channel",
      name: discordChannel.name,
      extensions: {
        [DISCORD_EXTENSION_KEYS.ROOM_ORIGIN]: {
          $type: DISCORD_EXTENSION_KEYS.ROOM_ORIGIN,
          snowflake: channelIdStr,
          guildId: this.guildId.toString(),
        },
      },
    });

    // Register mapping (repository handles "room:" prefix internally)
    await this.repo.registerMapping(roomKey, result.id);

    // Verify registration worked
    const verify = await this.repo.getRoomyId(roomKey);
    if (!verify) {
      console.error(`Failed to register mapping for ${roomKey} -> ${result.id}`);
    }

    return result.id;
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
    discordThread: ChannelProperties,
    parentDiscordChannelId: bigint,
  ): Promise<string> {
    const threadIdStr = discordThread.id.toString();
    const threadRoomKey = `room:${threadIdStr}`;

    // Idempotency check for thread
    const existingThread = await this.repo.getRoomyId(threadRoomKey);
    if (existingThread) return existingThread;

    // Ensure parent exists
    const parentRoomKey = `room:${parentDiscordChannelId.toString()}`;
    const parentRoomyId = await this.repo.getRoomyId(parentRoomKey);
    if (!parentRoomyId) {
      throw new Error(`Parent channel ${parentDiscordChannelId} not synced`);
    }

    // Call SDK operation to create thread (handles both room + link creation)
    const result = await createThread(this.connectedSpace, {
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

    // Get the link event ID (it's the second event sent by createThread)
    // createThread sends: createRoom event, then createRoomLink event
    // The createThread SDK operation returns only the thread ID, so we need to infer the link
    // We'll register the link mapping using a key pattern

    // Register link mapping
    const linkKey = `${parentRoomyId}:${result.id}`;
    // The link event ID would be returned by SDK in a real implementation
    // For now, we use the thread ID as a placeholder (this will be tracked by subscription handler)
    await this.repo.setRoomLink(linkKey, result.id);

    // Register thread mapping
    await this.repo.registerMapping(threadRoomKey, result.id);

    return result.id;
  }

  /**
   * Handle full Discord sidebar sync.
   * Syncs all channels, categories, threads, and their relationships.
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
    channels: ChannelProperties[],
    categories: ChannelProperties[],
  ): Promise<void> {
    // Build category map: categoryId -> roomyIds of child channels
    const categoryChildren = new Map<string, Ulid[]>();
    const uncategorizedChannels: Ulid[] = [];

    for (const channel of channels) {
      const roomKey = `room:${channel.id.toString()}`;
      let roomyId = await this.repo.getRoomyId(roomKey);

      // If not found, retry a few times (LevelDB might have timing issues)
      if (!roomyId) {
        for (let i = 0; i < 3; i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
          roomyId = await this.repo.getRoomyId(roomKey);
          if (roomyId) {
            console.log(`Channel ${channel.name} found in repo after retry ${i + 1}`);
            break;
          }
        }
      }

      if (!roomyId) {
        console.warn(`Channel ${channel.name} (${channel.id}) not found in repo after retries, skipping in sidebar`);
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

    // Build categories array for UpdateSidebar event
    const sidebarCategories: { name: string; children: Ulid[] }[] = [];

    // Add uncategorized channels to "general" category
    if (uncategorizedChannels.length > 0) {
      sidebarCategories.push({
        name: "general",
        children: uncategorizedChannels,
      });
    }

    // Add each Discord category (skip empty ones)
    for (const category of categories) {
      const children = categoryChildren.get(category.id.toString()) || [];
      if (children.length > 0) {
        sidebarCategories.push({
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

    console.log(`Updating sidebar with ${sidebarCategories.length} categories, ${uncategorizedChannels.length} uncategorized channels`);

    // Send sidebar update event
    const event = {
      id: newUlid(),
      $type: "space.roomy.space.updateSidebar.v0",
      categories: sidebarCategories,
      extensions: {
        [DISCORD_EXTENSION_KEYS.SIDEBAR_ORIGIN]: {
          $type: DISCORD_EXTENSION_KEYS.SIDEBAR_ORIGIN,
          guildId: this.guildId.toString(),
          sidebarHash: newHash,
        },
      },
    } as Event;

    await this.connectedSpace.sendEvent(event);

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

    // Skip if this room was synced from Discord (has discordOrigin extension)
    if (DISCORD_EXTENSION_KEYS.ROOM_ORIGIN in (event.extensions || {})) {
      return;
    }

    const roomyRoomId = event.id;
    const roomName = event.name || "unnamed-room";
    const roomKind = event.kind;

    // Only sync channels (not threads, pages, etc.)
    if (roomKind !== "space.roomy.channel") {
      return;
    }

    // Check if we've already synced this room
    const existingDiscordId = await this.repo.getDiscordId(roomyRoomId);
    if (existingDiscordId) {
      // Verify Discord channel still exists
      try {
        const channel = await discordFetchChannel(this.bot, { channelId: BigInt(existingDiscordId.replace("room:", "")) });
        // Channel exists, check if it has our marker
        if (!extractRoomyRoomId(channel.topic || null)) {
          // Channel exists but no marker - add it
          await this.bot.helpers.editChannel(channel.id, {
            topic: addRoomySyncMarker(channel.topic || null, roomyRoomId),
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

    console.log(`[StructureSyncService] Creating Discord channel for Roomy room`, {
      roomyRoomId,
      roomName,
      guildId: this.guildId.toString(),
      topic,
      botAvailable: !!this.bot,
    });

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

    console.log(`[StructureSyncService] Created Discord channel ${roomName} (${discordId}) for Roomy room ${roomyRoomId}`);

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
  async handleRoomySidebarUpdate(event: Event): Promise<void> {
    if (!this.bot) {
      console.warn("Bot not available, skipping Roomy → Discord sidebar sync");
      return;
    }

    const sidebar = event as {
      categories: Array<{ name: string; children: Ulid[] }>;
    };

    for (const category of sidebar.categories) {
      for (const roomyRoomId of category.children) {
        // Check if room has discordOrigin extension (skip if synced from Discord)
        const hasOrigin = await this.hasDiscordOrigin(roomyRoomId);
        if (hasOrigin) continue;

        // Check if we've already synced this room
        const existingDiscordId = await this.repo.getDiscordId(roomyRoomId);
        if (existingDiscordId) {
          // Verify Discord channel still exists and has our topic marker
          await this.verifyOrCreateChannel(roomyRoomId);
        } else {
          // Get room details from repo or fetch from event stream
          // For now, create with a default name - the actual name would come from createRoom event
          await this.createDiscordChannelFromRoomy(roomyRoomId, `roomy-${roomyRoomId.slice(0, 8)}`);
        }
      }
    }
  }

  /**
   * Check if a Roomy room has Discord origin (was synced from Discord).
   */
  private async hasDiscordOrigin(roomyRoomId: Ulid): Promise<boolean> {
    // Check if the room has a discordOrigin extension
    // This would require querying the event stream or maintaining a local cache
    // For now, we check the repo - if it has a room: prefixed mapping, it likely came from Discord
    const discordId = await this.repo.getDiscordId(roomyRoomId);
    return discordId?.startsWith("room:") ?? false;
  }

  /**
   * Verify a Discord channel exists and has our topic marker, or recreate it.
   */
  private async verifyOrCreateChannel(roomyRoomId: Ulid): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot required for Roomy → Discord sync");
    }

    const existingDiscordId = await this.repo.getDiscordId(roomyRoomId);
    if (!existingDiscordId) {
      // No mapping exists, create new channel
      await this.createDiscordChannelFromRoomy(roomyRoomId, `roomy-${roomyRoomId.slice(0, 8)}`);
      return;
    }

    const channelId = existingDiscordId.replace("room:", "");

    try {
      const channel = await discordFetchChannel(this.bot, { channelId: BigInt(channelId) });

      // Check if channel has our topic marker
      if (!extractRoomyRoomId(channel.topic || null)) {
        // Channel exists but no marker - add it
        await this.bot.helpers.editChannel(channel.id, {
          topic: addRoomySyncMarker(channel.topic || null, roomyRoomId),
        });
        console.log(`Added sync marker to existing channel ${channelId}`);
      }
    } catch {
      // Channel doesn't exist, recreate it
      console.warn(`Discord channel ${channelId} not found, recreating...`);
      await this.createDiscordChannelFromRoomy(roomyRoomId, `roomy-${roomyRoomId.slice(0, 8)}`);
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
      for (const [_, channel] of channels) {
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
  async handleRoomyRoomRename(roomyRoomId: Ulid, newName: string): Promise<void> {
    if (!this.bot) {
      console.warn("Bot not available, skipping Roomy → Discord rename sync");
      return;
    }

    const discordId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordId) return; // Not synced to Discord

    const channelId = discordId.replace("room:", "");

    try {
      const channel = await discordFetchChannel(this.bot, { channelId: BigInt(channelId) });

      if (channel.name !== newName) {
        await this.bot.helpers.editChannel(channel.id, {
          name: newName,
          reason: "Synced from Roomy",
        });
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
  async handleRoomyCategoryRename(oldName: string, newName: string): Promise<void> {
    if (!this.bot) {
      console.warn("Bot not available, skipping Roomy → Discord category rename sync");
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
}
