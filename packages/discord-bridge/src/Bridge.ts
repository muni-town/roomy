/**
 * SyncOrchestrator - Top-level coordinator for sync services.
 *
 * This class provides a single entry point for all sync operations,
 * delegating to the appropriate domain service.
 */

import type { BridgeRepository } from "./repositories/index.js";
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
import type { DiscordBot, DiscordEvent } from "./discord/types.js";
import { MessageSyncService } from "./services/MessageSyncService.js";
import { ReactionSyncService } from "./services/ReactionSyncService.js";
import {
  ProfileSyncService,
  type DiscordUser,
} from "./services/ProfileSyncService.js";
import { StructureSyncService } from "./services/StructureSyncService.js";
import { getRepo } from "./repositories/LevelDBBridgeRepository.js";
import { recordError, setRoomyAttrs, tracer } from "./tracing.js";
import { createDispatcher, EventDispatcher } from "./dispatcher.js";
import { EventCallbackMeta } from "@roomy/sdk";
import { Deferred } from "@roomy/sdk";
import { Event } from "@roomy/sdk";

type BridgeState =
  | {
      state: "backfillRoomy";
    }
  | {
      state: "backfillDiscordAndSyncToRoomy";
      lastBatchId: Ulid;
    }
  | { state: "syncRoomyToDiscord"; lastBatchId: Ulid }
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
    this.dispatcher = createDispatcher();

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

    this.backfillRoomyAndSubscribe();
    this.backfillDiscordAndSyncToRoomy();
    this.syncRoomyToDiscord();
  }

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
    const { spaceId, client } = options;

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

  /** Subscribe resuming from stored cursor. */
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
            1 as StreamIndex, // TODO put back 'cursor'
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

                const lastBatchId = await this.connectedSpace.doneBackfilling;

                this.state.current = {
                  state: "backfillDiscordAndSyncToRoomy",
                  lastBatchId,
                };

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

  /**
   * Handle a batch of Roomy events from the subscription stream.
   * No branching on backfill - single code path for all events.
   *
   * Phase 1: Populate mappings + queue Roomy-origin events
   * Phase 3: Process queued Roomy-origin events
   *
   * @param events - Batch of decoded Roomy events
   */
  async handleRoomyEvents(
    events: DecodedStreamEvent[],
    meta: EventCallbackMeta,
  ): Promise<void> {
    // console.log("handling Roomy events", events);
    let maxIdx = 0;

    events.forEach(async (decodedEvent, i) => {
      const { idx } = decodedEvent;
      const { batchId } = meta;
      maxIdx = Math.max(maxIdx, idx);

      const isLastEvent = i + 1 === events.length;

      // transition to 'listening' when last batch from Roomy is processed

      // Route to services (first one to handle wins)
      // Order matters: profile → structure → message → reaction
      // Services handle Discord-origin events (register mappings, drop) and
      // queue Roomy-origin events (push to dispatcher.toDiscord for Phase 3)
      (await this.profileSync.handleRoomyEvent(
        decodedEvent,
        batchId,
        isLastEvent,
      )) ||
        (await this.structureSync.handleRoomyEvent(
          decodedEvent,
          batchId,
          isLastEvent,
        )) ||
        (await this.messageSync.handleRoomyEvent(
          decodedEvent,
          batchId,
          isLastEvent,
        )) ||
        (await this.reactionSync.handleRoomyEvent(
          decodedEvent,
          batchId,
          isLastEvent,
        ));
    });

    // Update cursor to highest idx in batch
    if (maxIdx > 0) {
      await this.repo.setCursor(this.connectedSpace.streamDid, maxIdx);
    }
  }

  async backfillDiscordAndSyncToRoomy() {
    const current = await this.state.transitionedTo(
      "backfillDiscordAndSyncToRoomy",
    );
    console.log("Starting Discord backfill (Phase 2)");

    try {
      // Step 1: Backfill structure (channels and threads)
      console.log(
        "[Bridge] Backfilling Discord structure (channels/threads)...",
      );
      const structureCount = await this.structureSync.backfillToRoomy();
      console.log(`[Bridge] Synced ${structureCount} channels/threads`);

      // Get all text channel IDs for message/reaction backfill
      const channels = await this.bot.rest.getChannels(this.guildId.toString());
      const textChannelIds: bigint[] = [];

      for (const channel of Object.values(channels)) {
        // Only text channels (type 0), not threads (11, 12), voice (2), categories (4), etc.
        if (channel.type === 0) {
          textChannelIds.push(BigInt(channel.id));
        }
      }

      console.log(
        `[Bridge] Backfilling messages for ${textChannelIds.length} channels...`,
      );

      // Step 2: Backfill messages
      const messageCount =
        await this.messageSync.backfillToRoomy(textChannelIds);
      console.log(`[Bridge] Synced ${messageCount} messages`);

      // Step 3: Backfill reactions
      console.log("[Bridge] Backfilling reactions...");
      const reactionCount =
        await this.reactionSync.backfillToRoomy(textChannelIds);
      console.log(`[Bridge] Synced ${reactionCount} reactions`);

      console.log("[Bridge] Discord backfill complete");

      // Transition to Phase 3
      this.state.current = {
        state: "syncRoomyToDiscord",
        lastBatchId: current.lastBatchId,
      };
    } catch (error) {
      console.error("[Bridge] Error during Discord backfill:", error);
      throw error;
    }
  }

  syncDiscordToRoomy() {
    const batchSize = 100;

    // Internal batch queue for Discord → Roomy events
    const batchQueue: Event[] = [];

    /**
     * Flush the batch queue to Roomy.
     */
    const flushBatch = async (): Promise<void> => {
      if (batchQueue.length === 0) return;

      const events = batchQueue.splice(0, batchQueue.length);
      await this.connectedSpace.sendEvents(events);
      console.log(
        `[Dispatcher] Flushed batch of ${events.length} events to Roomy`,
      );
    };

    /**
     * Consumer loop for Discord → Roomy events.
     * Batches during backfill, sends immediately during listening.
     */
    (async () => {
      for await (const event of this.dispatcher.toRoomy) {
        const currentState = this.state.current.state;

        // During Discord backfill: batch events
        if (currentState === "backfillDiscordAndSyncToRoomy") {
          batchQueue.push(event);

          // Auto-flush when batch size reached
          if (batchQueue.length >= batchSize) {
            await flushBatch();
          }
        }
        // During listening: send immediately
        else if (currentState === "listening") {
          await this.connectedSpace.sendEvent(event);
        }
        // Other states: shouldn't be sending to Roomy
        else {
          console.warn(
            `[Dispatcher] Unexpected state for toRoomy: ${currentState}, discarding event`,
          );
        }
      }
    })();

    this.state.transitionedTo("syncRoomyToDiscord").then(() => {
      flushBatch();
    });
  }

  /**
   * Phase 3: Sync Roomy-origin data to Discord.
   * The dispatcher processes queued Roomy-origin events automatically.
   */
  syncRoomyToDiscord() {
    /**
     * Consumer loop for Roomy → Discord events.
     * Waits for Phase 3, then distributes events to registered services.
     */
    (async () => {
      const current = await this.state.transitionedTo("syncRoomyToDiscord");
      console.log("Starting Roomy → Discord sync (Phase 3)");
      for await (const { decoded, batchId, isLastEvent } of this.dispatcher
        .toDiscord) {
        console.log("handling Roomy event", decoded, batchId, isLastEvent);
        try {
          if (decoded) {
            // Distribute events to services
            await this.reactionSync.syncToDiscord(decoded);
            await this.structureSync.syncToDiscord(decoded);
            await this.messageSync.syncToDiscord(decoded);
            // We don't need ProfileSync to sync anything directly to Discord, it only populates db for other services to consume
            console.log("handled", decoded.event.id);
          }

          if (current.lastBatchId === batchId && isLastEvent) {
            console.log("Finished reconciliation, listening to new events");
            this.state.current = { state: "listening" };
          }
        } catch (error) {
          console.error(`[Dispatcher] Error in service.syncToDiscord:`, error);
        }
      }
    })();
  }
}
