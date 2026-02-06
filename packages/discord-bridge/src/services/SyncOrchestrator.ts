/**
 * SyncOrchestrator - Top-level coordinator for sync services.
 *
 * This class provides a single entry point for all sync operations,
 * delegating to the appropriate domain service.
 */

import type { BridgeRepository } from "../repositories/index.js";
import type { ConnectedSpace } from "@roomy/sdk";
import type { DecodedStreamEvent, Ulid } from "@roomy/sdk";
import type { DiscordBot, MessageProperties, ChannelProperties } from "../discord/types.js";
import type { Emoji } from "@discordeno/bot";
import { MessageSyncService, type EventBatcher } from "./MessageSyncService.js";
import { ReactionSyncService } from "./ReactionSyncService.js";
import { ProfileSyncService, type DiscordUser } from "./ProfileSyncService.js";
import { StructureSyncService } from "./StructureSyncService.js";

/**
 * Top-level coordinator for all sync operations.
 * Delegates to domain-specific services.
 */
export class SyncOrchestrator {
  constructor(
    private readonly messageSync: MessageSyncService,
    private readonly reactionSync: ReactionSyncService,
    private readonly profileSync: ProfileSyncService,
    private readonly structureSync: StructureSyncService,
  ) {}

  // ============================================================
  // DISCORD event handlers
  // ============================================================

  /**
   * Handle Discord message creation.
   * Delegates to MessageSyncService.
   */
  async handleDiscordMessageCreate(
    message: MessageProperties,
    roomyRoomId: string,
    batcher?: EventBatcher,
  ): Promise<string | null> {
    return await this.messageSync.syncDiscordToRoomy(roomyRoomId, message, batcher);
  }

  /**
   * Handle Discord message update.
   * Delegates to MessageSyncService.
   * Note: roomyRoomId is looked up internally by the service from the channel mapping.
   */
  async handleDiscordMessageUpdate(message: MessageProperties): Promise<void> {
    await this.messageSync.syncEditToRoomy(message);
  }

  /**
   * Handle Discord message deletion.
   * Delegates to MessageSyncService.
   */
  async handleDiscordMessageDelete(messageId: bigint, channelId: bigint): Promise<void> {
    await this.messageSync.syncDeleteToRoomy(messageId, channelId);
  }

  /**
   * Handle Discord reaction add.
   * Delegates to ReactionSyncService.
   */
  async handleDiscordReactionAdd(
    messageId: bigint,
    channelId: bigint,
    userId: bigint,
    emoji: Partial<Emoji>,
  ): Promise<string | null> {
    return await this.reactionSync.syncAddToRoomy(messageId, channelId, userId, emoji);
  }

  /**
   * Handle Discord reaction remove.
   * Delegates to ReactionSyncService.
   */
  async handleDiscordReactionRemove(
    messageId: bigint,
    channelId: bigint,
    userId: bigint,
    emoji: Partial<Emoji>,
  ): Promise<void> {
    await this.reactionSync.syncRemoveToRoomy(messageId, channelId, userId, emoji);
  }

  /**
   * Handle Discord user profile sync.
   * Delegates to ProfileSyncService.
   * @param user - Discord user to sync
   * @param batcher - Optional event batcher for bulk operations
   */
  async handleDiscordUserProfile(user: DiscordUser, batcher?: EventBatcher): Promise<void> {
    await this.profileSync.syncDiscordToRoomy(user, batcher);
  }

  /**
   * Handle Discord channel creation.
   * Delegates to StructureSyncService.
   */
  async handleDiscordChannelCreate(channel: ChannelProperties): Promise<string> {
    return await this.structureSync.handleDiscordChannelCreate(channel);
  }

  /**
   * Handle Discord thread creation.
   * Delegates to StructureSyncService.
   */
  async handleDiscordThreadCreate(
    thread: ChannelProperties,
    parentChannelId: bigint,
  ): Promise<string> {
    return await this.structureSync.handleDiscordThreadCreate(thread, parentChannelId);
  }

  /**
   * Handle full Discord sidebar update.
   * Delegates to StructureSyncService.
   */
  async handleDiscordSidebarUpdate(
    channels: ChannelProperties[],
    categories: ChannelProperties[],
  ): Promise<void> {
    await this.structureSync.syncFullDiscordSidebar(channels, categories);
  }

  // ============================================================
  // ROOMY event handlers (Roomy → Discord sync)
  // ============================================================

  /**
   * Handle Roomy create message event.
   * Syncs the message to Discord via webhook.
   */
  async handleRoomyCreateMessage(
    decoded: DecodedStreamEvent,
    bot: DiscordBot,
  ): Promise<void> {
    const { event, user } = decoded;
    const e = event as any;

    if (!e.room || !e.body) {
      console.warn("[SyncOrchestrator] Invalid Roomy create message event, missing room or body");
      return;
    }

    await this.messageSync.syncRoomyToDiscordCreate(
      event.id,
      e.room,
      e.body,
      user,
      bot,
    );
  }

  /**
   * Handle Roomy edit message event.
   * Edits the Discord message.
   */
  async handleRoomyEditMessage(
    decoded: DecodedStreamEvent,
    bot: DiscordBot,
  ): Promise<void> {
    const { event } = decoded;
    const e = event as any;

    if (!e.messageId || !e.room || !e.body) {
      console.warn("[SyncOrchestrator] Invalid Roomy edit message event, missing messageId, room, or body");
      return;
    }

    await this.messageSync.syncRoomyToDiscordEdit(
      e.messageId,
      e.room,
      e.body,
      bot,
    );
  }

  /**
   * Handle Roomy delete message event.
   * Deletes the Discord message.
   */
  async handleRoomyDeleteMessage(
    decoded: DecodedStreamEvent,
    bot: DiscordBot,
  ): Promise<void> {
    const { event } = decoded;
    const e = event as any;

    if (!e.messageId) {
      console.warn("[SyncOrchestrator] Invalid Roomy delete message event, missing messageId");
      return;
    }

    await this.messageSync.syncRoomyToDiscordDelete(
      e.messageId,
      e.room || "",
      bot,
    );
  }

  /**
   * Handle Roomy add reaction event.
   * Adds reaction to Discord message.
   */
  async handleRoomyAddReaction(
    decoded: DecodedStreamEvent,
    bot: DiscordBot,
  ): Promise<void> {
    const { event, user } = decoded;
    const e = event as any;

    if (!e.reactionTo || !e.reaction || !e.room) {
      console.warn("[SyncOrchestrator] Invalid Roomy add reaction event, missing reactionTo, reaction, or room");
      return;
    }

    await this.reactionSync.syncRoomyToDiscordAdd(
      e.reactionTo,
      e.room,
      e.reaction,
      user,
      bot,
    );
  }

  /**
   * Handle Roomy remove reaction event.
   * Removes reaction from Discord message.
   */
  async handleRoomyRemoveReaction(
    decoded: DecodedStreamEvent,
    bot: DiscordBot,
  ): Promise<void> {
    const { event, user } = decoded;
    const e = event as any;

    if (!e.reactionId || !e.room) {
      console.warn("[SyncOrchestrator] Invalid Roomy remove reaction event, missing reactionId or room");
      return;
    }

    await this.reactionSync.syncRoomyToDiscordRemove(
      e.reactionId,
      e.room,
      user,
      bot,
    );
  }

  /**
   * Handle Roomy create room event.
   * Creates a Discord channel if the room doesn't have Discord origin.
   */
  async handleRoomyCreateRoom(
    event: DecodedStreamEvent,
    bot: DiscordBot,
  ): Promise<void> {
    return await this.structureSync.handleRoomyRoomCreate(event.event as any);
  }

  /**
   * Handle Roomy update sidebar event.
   * Syncs Roomy sidebar structure to Discord channels.
   */
  async handleRoomyUpdateSidebar(
    event: DecodedStreamEvent,
    bot: DiscordBot,
  ): Promise<void> {
    return await this.structureSync.handleRoomySidebarUpdate(event.event as any);
  }

  /**
   * Recover Discord channel mappings from Discord topics.
   * Called on bridge startup when local data may be lost.
   */
  async recoverMappings(): Promise<void> {
    return await this.structureSync.recoverDiscordMappings();
  }

  /**
   * Handle Roomy room rename - update Discord channel name.
   */
  async handleRoomyRoomRename(roomyRoomId: string, newName: string): Promise<void> {
    return await this.structureSync.handleRoomyRoomRename(roomyRoomId as Ulid, newName);
  }

  /**
   * Handle Roomy category rename - update Discord category.
   */
  async handleRoomyCategoryRename(oldName: string, newName: string): Promise<void> {
    return await this.structureSync.handleRoomyCategoryRename(oldName, newName);
  }

  /**
   * Clear internal caches.
   * Call this between tests to ensure fresh state.
   */
  clearCache(): void {
    this.structureSync.clearCache();
  }
}

/**
 * Factory function to create a SyncOrchestrator with all its dependencies.
 *
 * @param repo - Bridge repository
 * @param connectedSpace - Connected Roomy space
 * @param guildId - Discord guild ID
 * @param spaceId - Roomy space ID
 * @param bot - Optional Discord bot instance
 * @returns Configured SyncOrchestrator
 *
 * @example
 * ```ts
 * const orchestrator = createSyncOrchestrator({
 *   repo,
 *   connectedSpace,
 *   guildId: 123n,
 *   spaceId: "did:plc:abc",
 *   bot: discordBot,
 * });
 * ```
 */
export function createSyncOrchestrator(options: {
  repo: BridgeRepository;
  connectedSpace: ConnectedSpace;
  guildId: bigint;
  spaceId: string;
  bot?: DiscordBot;
}): SyncOrchestrator {
  const { repo, connectedSpace, guildId, spaceId, bot } = options;

  // Create services (order matters for dependencies)
  const profileService = new ProfileSyncService(repo, connectedSpace, guildId, spaceId);
  const reactionService = new ReactionSyncService(repo, connectedSpace, guildId, spaceId);
  const structureService = new StructureSyncService(repo, connectedSpace, guildId, spaceId, bot);
  const messageService = new MessageSyncService(repo, connectedSpace, guildId, spaceId, profileService, bot);

  return new SyncOrchestrator(
    messageService,
    reactionService,
    profileService,
    structureService,
  );
}
