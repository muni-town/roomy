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

// Import SDK operations from @roomy/sdk/package/operations
import { createRoom, createThread } from "@roomy/sdk/package/operations";

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
   * Handle Roomy room creation (stub for Roomy → Discord sync).
   * TODO: Determine if this room should create a Discord channel.
   *
   * @param event - Roomy createRoom event
   *
   * @example
   * ```ts
   * await service.handleRoomyRoomCreate(roomyEvent);
   * ```
   */
  async handleRoomyRoomCreate(event: Event): Promise<void> {
    // TODO: Determine if this room should create a Discord channel
    // Call SDK operation: createChannel() from discord/operations/channel.ts
    throw new Error("Not implemented");
  }

  /**
   * Handle Roomy sidebar update (stub for Roomy → Discord sync).
   * TODO: Derive Discord structure, compute diff.
   *
   * @param event - Roomy updateSidebar event
   *
   * @example
   * ```ts
   * await service.handleRoomySidebarUpdate(roomyEvent);
   * ```
   */
  async handleRoomySidebarUpdate(event: Event): Promise<void> {
    // TODO: Derive Discord structure, compute diff
    // Call SDK operations: createChannel(), createThread() from discord/operations/
    throw new Error("Not implemented");
  }
}
