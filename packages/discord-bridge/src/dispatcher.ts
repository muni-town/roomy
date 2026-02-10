/**
 * EventDispatcher - Bidirectional event routing with batching
 *
 * Evolution of EventBatcher with phase-aware batching using AsyncChannel.
 * Coordinates event flow between Discord and Roomy:
 * - toRoomy: Discord → Roomy events (batched during backfill, immediate during listening)
 * - toDiscord: Roomy → Discord events (queued during Phase 1, consumed after Phase 3)
 *
 * Services push events to channels, and dispatcher coordinates consumption.
 */

import { AsyncChannel, type Event, type StateMachine } from "@roomy/sdk";
import type { ConnectedSpace, DecodedStreamEvent } from "@roomy/sdk";

const DEFAULT_BATCH_SIZE = 100;

type BridgeState =
  | { state: "backfillRoomy" }
  | { state: "backfillDiscordAndSyncToRoomy" }
  | { state: "syncRoomyToDiscord" }
  | { state: "listening" };

/**
 * Service interface for Discord sync operations.
 * Services implement this to handle Roomy → Discord syncing.
 */
export interface DiscordSyncService {
  syncToDiscord(event: DecodedStreamEvent): Promise<void>;
}

/**
 * Dispatcher holds both directional channels for bidirectional sync.
 * Channels are AsyncChannel instances that handle event queuing and processing.
 */
export interface EventDispatcher {
  // Discord → Roomy: batched during backfill, immediate during listening
  toRoomy: AsyncChannel<Event>;
  // Roomy → Discord: queued during Phase 1, consumed after Phase 3 starts
  toDiscord: AsyncChannel<DecodedStreamEvent>;
  // Promise that resolves when Phase 3 is ready
  phase3Ready: Promise<unknown>;
  // Manually flush any pending Discord → Roomy events
  flushRoomy(): Promise<void>;
  // Register services that participate in Roomy → Discord sync
  registerDiscordSyncService(service: DiscordSyncService): void;
}

/**
 * Create an EventDispatcher with state-aware batching and Phase 3 suspension.
 *
 * The dispatcher provides channels for both directions:
 * - toRoomy: Has built-in consumer loop that batches/sends based on state
 * - toDiscord: Queues events during Phase 1, then iterates and calls service.syncToDiscord() after Phase 3
 *
 * @param connectedSpace - ConnectedSpace instance for sending events
 * @param stateMachine - Bridge state machine for determining batch vs immediate
 * @param batchSize - Number of events to batch before auto-flush (default: 100)
 * @returns EventDispatcher with both directional channels
 *
 * @example
 * ```ts
 * const dispatcher = createDispatcher(connectedSpace, bridge.state);
 *
 * // Register services for Roomy → Discord sync
 * dispatcher.registerDiscordSyncService(messageSyncService);
 * dispatcher.registerDiscordSyncService(reactionSyncService);
 *
 * // Discord → Roomy: batches during backfill, immediate during listening
 * dispatcher.toRoomy.push(event);
 *
 * // Roomy → Discord: queued, dispatcher distributes to services after Phase 3
 * dispatcher.toDiscord.push(decodedEvent);
 *
 * // Flush pending events after backfill
 * await dispatcher.flushRoomy();
 * ```
 */
export function createDispatcher(
  connectedSpace: ConnectedSpace,
  stateMachine: StateMachine<BridgeState>,
  batchSize = DEFAULT_BATCH_SIZE,
): EventDispatcher {
  const toRoomy = new AsyncChannel<Event>();
  const toDiscord = new AsyncChannel<DecodedStreamEvent>();

  // Internal batch queue for Discord → Roomy events
  const batchQueue: Event[] = [];

  // Services that handle Roomy → Discord sync
  const discordSyncServices: DiscordSyncService[] = [];

  /**
   * Flush the batch queue to Roomy.
   */
  const flushBatch = async (): Promise<void> => {
    if (batchQueue.length === 0) return;

    const events = batchQueue.splice(0, batchQueue.length);
    await connectedSpace.sendEvents(events);
    console.log(
      `[Dispatcher] Flushed batch of ${events.length} events to Roomy`,
    );
  };

  /**
   * Consumer loop for Discord → Roomy events.
   * Batches during backfill, sends immediately during listening.
   */
  (async () => {
    for await (const event of toRoomy) {
      const currentState = stateMachine.current.state;

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
        await connectedSpace.sendEvent(event);
      }
      // Other states: shouldn't be sending to Roomy
      else {
        console.warn(
          `[Dispatcher] Unexpected state for toRoomy: ${currentState}, discarding event`,
        );
      }
    }
  })();

  // Phase 3 promise - services can await this before consuming toDiscord
  const phase3Ready = stateMachine.transitionedTo("syncRoomyToDiscord");

  /**
   * Consumer loop for Roomy → Discord events.
   * Waits for Phase 3, then distributes events to registered services.
   */
  (async () => {
    // Wait for Phase 3 to start
    await phase3Ready;

    console.log("[Dispatcher] Starting Roomy → Discord sync consumer");

    // Distribute events to services (first one to handle wins)
    for await (const decoded of toDiscord) {
      console.log("handling Roomy event", decoded);
      for (const service of discordSyncServices) {
        try {
          await service.syncToDiscord(decoded);
          break; // First service to handle wins
        } catch (error) {
          console.error(`[Dispatcher] Error in service.syncToDiscord:`, error);
        }
      }
    }
  })();

  return {
    toRoomy,
    toDiscord,
    phase3Ready,
    async flushRoomy() {
      await flushBatch();
    },
    registerDiscordSyncService(service: DiscordSyncService) {
      discordSyncServices.push(service);
    },
  };
}
