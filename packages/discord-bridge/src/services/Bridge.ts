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
  StateMachine,
  StreamIndex,
  Ulid,
} from "@roomy/sdk";
import type { DiscordBot, DiscordEvent } from "../discord/types.js";
import { MessageSyncService } from "./MessageSyncService.js";
import { ReactionSyncService } from "./ReactionSyncService.js";
import { ProfileSyncService, type DiscordUser } from "./ProfileSyncService.js";
import { StructureSyncService } from "./StructureSyncService.js";
import { getRepo } from "../repositories/LevelDBBridgeRepository.js";
import { recordError, setRoomyAttrs, tracer } from "../tracing.js";
import { createDispatcher, EventDispatcher } from "../dispatcher.js";

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
  state: StateMachine<BridgeState>;
  repo: BridgeRepository;
  dispatcher: EventDispatcher;
  connectedSpace: ConnectedSpace;
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
    this.state = stateMachine({ state: "backfillRoomy" });
    this.bot = bot;
    this.repo = repo;

    // Create dispatcher
    this.dispatcher = createDispatcher(connectedSpace, this.state);

    // Create services (order matters for dependencies)
    this.profileSync = new ProfileSyncService(
      repo,
      connectedSpace.streamDid,
      this.dispatcher,
      guildId,
    );
    this.reactionSync = new ReactionSyncService(
      repo,
      connectedSpace.streamDid,
      this.dispatcher,
      guildId,
      bot,
    );
    this.structureSync = new StructureSyncService(
      repo,
      connectedSpace.streamDid,
      this.dispatcher,
      guildId,
      bot,
      connectedSpace,
    );
    this.messageSync = new MessageSyncService(
      repo,
      connectedSpace.streamDid,
      this.dispatcher,
      guildId,
      this.profileSync,
      bot,
    );

    // Register services with dispatcher for Roomy → Discord sync
    this.dispatcher.registerDiscordSyncService(this.reactionSync);
    this.dispatcher.registerDiscordSyncService(this.structureSync);
    this.dispatcher.registerDiscordSyncService(this.messageSync);
    // We don't need ProfileSync to sync anything directly to Discord, it only populates db for other services to consume

    this.backfillRoomyAndSubscribe();
    this.backfillDiscordAndSyncToRoomy();
  }

  // ============================================================
  // DISCORD event handlers
  // ============================================================

  /**
   * Handle Discord events using unified type-safe routing.
   * Delegates to appropriate service based on event type.
   */
  async handleDiscordEvent(discordEvent: DiscordEvent): Promise<void> {
    switch (discordEvent.event) {
      case "MESSAGE_CREATE":
        await this.messageSync.syncDiscordToRoomy(discordEvent.payload);
        break;

      case "MESSAGE_UPDATE":
        await this.messageSync.syncEditToRoomy(discordEvent.payload);
        break;

      case "MESSAGE_DELETE":
        await this.messageSync.syncDeleteToRoomy(
          discordEvent.payload.messageId,
          discordEvent.payload.channelId,
        );
        break;

      case "REACTION_ADD":
        await this.reactionSync.syncAddToRoomy(
          discordEvent.payload.messageId,
          discordEvent.payload.channelId,
          discordEvent.payload.userId,
          discordEvent.payload.emoji,
        );
        break;

      case "REACTION_REMOVE":
        await this.reactionSync.syncRemoveToRoomy(
          discordEvent.payload.messageId,
          discordEvent.payload.channelId,
          discordEvent.payload.userId,
          discordEvent.payload.emoji,
        );
        break;

      case "CHANNEL_CREATE":
        await this.structureSync.handleDiscordChannelCreate(
          discordEvent.payload,
        );
        break;

      case "THREAD_CREATE":
        await this.structureSync.handleDiscordThreadCreate(
          discordEvent.payload,
          discordEvent.payload.parentId,
        );
        break;

      default:
        console.warn(
          `[Bridge] Unknown Discord event type: ${(discordEvent as any).event}`,
        );
    }
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
   * No branching on backfill - single code path for all events.
   *
   * Phase 1: Populate mappings + queue Roomy-origin events
   * Phase 3: Process queued Roomy-origin events
   *
   * @param events - Batch of decoded Roomy events
   */
  async handleRoomyEvents(events: DecodedStreamEvent[]): Promise<void> {
    let maxIdx = 0;

    for (const decodedEvent of events) {
      const { idx } = decodedEvent;
      maxIdx = Math.max(maxIdx, idx);

      // Route to services (first one to handle wins)
      // Order matters: profile → structure → message → reaction
      // Services handle Discord-origin events (register mappings, drop) and
      // queue Roomy-origin events (push to dispatcher.toDiscord for Phase 3)
      (await this.profileSync.handleRoomyEvent(decodedEvent)) ||
        (await this.structureSync.handleRoomyEvent(decodedEvent)) ||
        (await this.messageSync.handleRoomyEvent(decodedEvent)) ||
        (await this.reactionSync.handleRoomyEvent(decodedEvent));
    }

    // Update cursor to highest idx in batch
    if (maxIdx > 0) {
      await this.repo.setCursor(this.connectedSpace.streamDid, maxIdx);
    }
  }
}
