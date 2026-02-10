/**
 * SyncOrchestrator - Top-level coordinator for sync services.
 *
 * This class provides a single entry point for all sync operations,
 * delegating to the appropriate domain service.
 */

import type { BridgeRepository } from "../repositories/index.js";
import {
  modules,
  ConnectedSpace,
  type RoomyClient,
  type StreamDid,
  stateMachine,
} from "@roomy/sdk";
import type {
  DecodedStreamEvent,
  EventCallbackMeta,
  StateMachine,
  StreamIndex,
  Ulid,
} from "@roomy/sdk";
import type {
  DiscordBot,
  MessageProperties,
  ChannelProperties,
} from "../discord/types.js";
import type { Emoji } from "@discordeno/bot";
import { MessageSyncService, type EventBatcher } from "./MessageSyncService.js";
import { ReactionSyncService } from "./ReactionSyncService.js";
import { ProfileSyncService, type DiscordUser } from "./ProfileSyncService.js";
import { StructureSyncService } from "./StructureSyncService.js";
import { getRepo } from "../repositories/LevelDBBridgeRepository.js";
import { recordError, setRoomyAttrs, tracer } from "../tracing.js";
import {
  extractDiscordMessageOrigin,
  extractDiscordOrigin,
  extractDiscordUserOrigin,
  extractDiscordSidebarOrigin,
  extractDiscordRoomLinkOrigin,
} from "../utils/event-extensions.js";
import { getRoomKey } from "../utils/room.js";

type BridgeState =
  | {
      state: "backfillRoomy";
    }
  | {
      state: "backfillDiscordAndSyncToRoomy";
    }
  | { state: "syncRoomyToDiscord" }
  | {
      state: "listening";
    };

/**
 * Coordinator for sync operations for a specific guild-space pair.
 * Delegates to domain-specific services.
 * Manages backfill then can handle incoming Discord and Roomy events.
 */
export class Bridge {
  bot: DiscordBot;
  guildId: bigint;
  connectedSpace: ConnectedSpace;
  state: StateMachine<BridgeState>;
  repo: BridgeRepository;
  messageSync: MessageSyncService;
  reactionSync: ReactionSyncService;
  profileSync: ProfileSyncService;
  structureSync: StructureSyncService;

  constructor(options: {
    connectedSpace: ConnectedSpace;
    guildId: bigint;
    bot: DiscordBot;
  }) {
    const { connectedSpace, guildId, bot } = options;
    const repo = getRepo(guildId, connectedSpace.streamDid);
    this.guildId = guildId;
    this.connectedSpace = connectedSpace;
    this.bot = bot;

    // Create services (order matters for dependencies)
    this.profileSync = new ProfileSyncService(repo, connectedSpace, guildId);
    this.reactionSync = new ReactionSyncService(
      repo,
      connectedSpace,
      guildId,
      bot,
    );
    this.structureSync = new StructureSyncService(
      repo,
      connectedSpace,
      guildId,
      bot,
    );
    this.messageSync = new MessageSyncService(
      repo,
      connectedSpace,
      guildId,
      this.profileSync,
      bot,
    );
    this.repo = repo;
    this.state = stateMachine({ state: "backfillRoomy" });
    this.backfillRoomyAndSubscribe();
    this.backfillDiscordAndSyncToRoomy();
  }

  // ============================================================
  // DISCORD event handlers
  // ============================================================

  /**
   * Handle Discord message creation.
   * Delegates to MessageSyncService.
   */
  async handleDiscordMessageCreate(
    message: MessageProperties,
    batcher?: EventBatcher,
  ): Promise<string | null> {
    return await this.messageSync.syncDiscordToRoomy(message, batcher);
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
  async handleDiscordMessageDelete(
    messageId: bigint,
    channelId: bigint,
  ): Promise<void> {
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
    return await this.reactionSync.syncAddToRoomy(
      messageId,
      channelId,
      userId,
      emoji,
    );
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
    await this.reactionSync.syncRemoveToRoomy(
      messageId,
      channelId,
      userId,
      emoji,
    );
  }

  /**
   * Handle Discord user profile sync.
   * Delegates to ProfileSyncService.
   * @param user - Discord user to sync
   * @param batcher - Optional event batcher for bulk operations
   */
  async handleDiscordUserProfile(
    user: DiscordUser,
    batcher?: EventBatcher,
  ): Promise<void> {
    await this.profileSync.syncDiscordToRoomy(user, batcher);
  }

  /**
   * Handle Discord channel creation.
   * Delegates to StructureSyncService.
   */
  async handleDiscordChannelCreate(
    channel: ChannelProperties,
  ): Promise<string> {
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
    return await this.structureSync.handleDiscordThreadCreate(
      thread,
      parentChannelId,
    );
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
      console.warn(
        "[SyncOrchestrator] Invalid Roomy create message event, missing room or body",
      );
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
      console.warn(
        "[SyncOrchestrator] Invalid Roomy edit message event, missing messageId, room, or body",
      );
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
      console.warn(
        "[SyncOrchestrator] Invalid Roomy delete message event, missing messageId",
      );
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
      console.warn(
        "[SyncOrchestrator] Invalid Roomy add reaction event, missing reactionTo, reaction, or room",
      );
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
      console.warn(
        "[SyncOrchestrator] Invalid Roomy remove reaction event, missing reactionId or room",
      );
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
    return await this.structureSync.handleRoomySidebarUpdate(
      event.event as any,
    );
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
  async handleRoomyRoomRename(
    roomyRoomId: string,
    newName: string,
  ): Promise<void> {
    return await this.structureSync.handleRoomyRoomRename(
      roomyRoomId as Ulid,
      newName,
    );
  }

  /**
   * Handle Roomy category rename - update Discord category.
   */
  async handleRoomyCategoryRename(
    oldName: string,
    newName: string,
  ): Promise<void> {
    return await this.structureSync.handleRoomyCategoryRename(oldName, newName);
  }

  /**
   * Clear internal caches.
   * Call this between tests to ensure fresh state.
   */
  clearCache(): void {
    this.structureSync.clearCache();
  }

  /**
   * Connect to a single space
   */
  static async connect(options: {
    spaceId: StreamDid;
    bot: DiscordBot;
    guildId: bigint;
    client: RoomyClient;
  }): Promise<Bridge> {
    const { spaceId, bot, guildId, client } = options;

    console.log(`Connecting to space ${spaceId}...`);

    // Connect to the space
    const connectedSpace = await tracer.startActiveSpan(
      "leaf.stream.connect",
      async (connectSpan) => {
        try {
          const s = await ConnectedSpace.connect({
            client,
            streamDid: spaceId,
            module: modules.space,
          });

          connectSpan.setAttribute("connection.status", "success");
          return s;
        } catch (e) {
          recordError(connectSpan, e);
          throw e;
        } finally {
          connectSpan.end();
        }
      },
    );

    return new Bridge({ connectedSpace, ...options });
  }

  async disconnect() {
    await this.repo.delete();
  }

  /** Subscribe  resuming from stored cursor. */
  backfillRoomyAndSubscribe() {
    return tracer.startActiveSpan(
      "leaf.stream.subscribe",
      { attributes: { "roomy.space.id": this.connectedSpace.streamDid } },
      async (span) => {
        try {
          // Get the cursor to resume from
          const cursor = await this.repo.getLastProcessedIdx(
            this.connectedSpace.streamDid,
          );
          console.log(
            `Resuming space ${this.connectedSpace.streamDid} from idx ${cursor}`,
          );
          span.setAttribute("subscription.resume_cursor", cursor ?? "none");
          // Subscribe with the handler
          this.connectedSpace.subscribe(
            this.handleRoomyEvents.bind(this),
            cursor as StreamIndex,
          );
          // Wait for backfill to complete before returning
          console.log(
            `Waiting for backfill of space ${this.connectedSpace.streamDid}...`,
          );
          await tracer.startActiveSpan(
            "leaf.stream.backfill",
            async (backfillSpan) => {
              try {
                setRoomyAttrs(backfillSpan, {
                  spaceId: this.connectedSpace.streamDid,
                });
                await this.connectedSpace.doneBackfilling;
                backfillSpan.setAttribute("backfill.status", "complete");
              } catch (e) {
                recordError(backfillSpan, e);
                throw e;
              } finally {
                backfillSpan.end();
              }
            },
          );
          console.log(
            `Backfill complete for space ${this.connectedSpace.streamDid}`,
          );
          console.log(`Subscribed to space ${this.connectedSpace.streamDid}`);
          span.setAttribute("subscription.status", "connected");
        } catch (e) {
          recordError(span, e);
          throw e;
        } finally {
          span.end();
        }
      },
    );
  }

  async backfillDiscordAndSyncToRoomy() {
    await this.state.transitionedTo("backfillDiscordAndSyncToRoomy");
    console.log("Backfilling Discord");
  }

  /**
   * Handle a batch of Roomy events from the subscription stream.
   * Routes events to appropriate services based on event type.
   * Uses first-one-wins strategy - the first service to handle the event wins.
   *
   * @param events - Batch of decoded Roomy events
   * @param meta - Event metadata (backfill status, etc.)
   */
  async handleRoomyEvents(
    events: DecodedStreamEvent[],
    meta: EventCallbackMeta,
  ): Promise<void> {
    let maxIdx = 0;

    for (const decodedEvent of events) {
      const { idx } = decodedEvent;
      maxIdx = Math.max(maxIdx, idx);

      // During backfill, only do state management (no Discord sync)
      if (meta.isBackfill) {
        await this.handleRoomyEventForBackfill(decodedEvent);
      } else {
        // Route to services in order (first one to handle wins)
        // Order matters: profile → structure → message → reaction
        (await this.profileSync.handleRoomyEvent(decodedEvent)) ||
          (await this.structureSync.handleRoomyEvent(decodedEvent)) ||
          (await this.messageSync.handleRoomyEvent(decodedEvent)) ||
          (await this.reactionSync.handleRoomyEvent(decodedEvent));
      }
    }

    // Update cursor to highest idx in batch
    if (maxIdx > 0) {
      await this.repo.setCursor(this.connectedSpace.streamDid, maxIdx);
    }
  }

  /**
   * Handle events during backfill (state management only, no Discord sync).
   * This ensures we don't accidentally sync to Discord during backfill.
   *
   * @param decodedEvent - The decoded Roomy event
   */
  private async handleRoomyEventForBackfill(
    decodedEvent: DecodedStreamEvent,
  ): Promise<void> {
    const { event } = decodedEvent;

    // Register Discord message mappings
    const messageOrigin = extractDiscordMessageOrigin(event);
    if (messageOrigin) {
      try {
        await this.repo.registerMapping(messageOrigin.snowflake, event.id);
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("already registered"))) {
          console.error("Error registering synced ID:", e);
        }
      }
    }

    // Register Discord room mappings
    const roomOrigin = extractDiscordOrigin(event);
    if (roomOrigin) {
      try {
        await this.repo.registerMapping(
          getRoomKey(roomOrigin.snowflake),
          event.id,
        );
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("already registered"))) {
          console.error("Error registering synced ID:", e);
        }
      }
    }

    // Cache Discord user profile hashes
    const userOrigin = extractDiscordUserOrigin(event);
    if (userOrigin && userOrigin.guildId === this.guildId.toString()) {
      try {
        await this.repo.setProfileHash(
          userOrigin.snowflake,
          userOrigin.profileHash,
        );
      } catch (e) {
        console.error("Error caching profile hash:", e);
      }
    }

    // Cache sidebar hashes
    const sidebarOrigin = extractDiscordSidebarOrigin(event);
    if (sidebarOrigin && sidebarOrigin.guildId === this.guildId.toString()) {
      try {
        await this.repo.setSidebarHash(sidebarOrigin.sidebarHash);
      } catch (e) {
        console.error("Error caching sidebar hash:", e);
      }
    }

    // Cache room links
    const roomLinkData = extractDiscordRoomLinkOrigin(event);
    if (
      roomLinkData &&
      roomLinkData.origin.guildId === this.guildId.toString()
    ) {
      const parentRoomyId = (event as any).room;
      if (parentRoomyId) {
        const linkKey = `${parentRoomyId}:${roomLinkData.linkToRoom}`;
        try {
          await this.repo.setRoomLink(linkKey, event.id);
        } catch (e) {
          console.error("Error caching room link:", e);
        }
      }
    }

    // Cache edit tracking info
    if (event.$type === "space.roomy.message.editMessage.v0") {
      const origin = extractDiscordMessageOrigin(event);
      if (origin?.editedTimestamp && origin?.contentHash) {
        try {
          await this.repo.setEditInfo(origin.snowflake, {
            editedTimestamp: origin.editedTimestamp,
            contentHash: origin.contentHash,
          });
        } catch (e) {
          console.error("Error caching edit state:", e);
        }
      }
    }

    // Unregister deleted room mappings
    if (event.$type === "space.roomy.room.deleteRoom.v0") {
      try {
        const discordId = await this.repo.getDiscordId(event.roomId);
        if (discordId) {
          await this.repo.unregisterMapping(discordId, event.roomId);
        }
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("isn't registered"))) {
          console.error("Error unregistering room:", e);
        }
      }
    }

    // Unregister deleted message mappings
    if (event.$type === "space.roomy.message.deleteMessage.v0") {
      try {
        const discordId = await this.repo.getDiscordId(event.messageId);
        if (discordId) {
          await this.repo.unregisterMapping(discordId, event.messageId);
        }
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("isn't registered"))) {
          console.error("Error unregistering message:", e);
        }
      }
    }
  }
}
