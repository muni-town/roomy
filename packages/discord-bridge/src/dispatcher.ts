/**
 * EventDispatcher - Bidirectional event routing with batching
 *
 * Coordinates event flow between Discord and Roomy:
 * - toRoomy: Discord → Roomy events (batched during backfill, immediate during listening)
 * - toDiscord: Roomy → Discord events (queued during Phase 1, consumed after Phase 3)
 */

import { AsyncChannel, type Event } from "@roomy/sdk";
import type { DecodedStreamEvent, Ulid } from "@roomy/sdk";

/**
 * Dispatcher holds both directional channels for bidirectional sync.
 * Channels are AsyncChannel instances that handle event queuing and processing.
 */
export interface EventDispatcher {
  // Discord → Roomy: batched during backfill, immediate during listening
  toRoomy: AsyncChannel<Event>;
  // Roomy → Discord: queued during Phase 1, consumed after Phase 3 starts
  toDiscord: AsyncChannel<{
    decoded?: DecodedStreamEvent;
    batchId: Ulid;
    isLastEvent: boolean;
  }>;
}

/**
 * Create an EventDispatcher
 *
 * The dispatcher provides channels for both directions:
 * - toRoomy: Has built-in consumer loop that batches/sends based on state
 * - toDiscord: Queues events during Phase 1, then iterates and calls service.syncToDiscord() after Phase 3
 *
 * @returns EventDispatcher with both directional channels
 *
 * @example
 * ```ts
 * const dispatcher = createDispatcher(connectedSpace, bridge.state);
 *
 * // Discord → Roomy: batches during backfill, immediate during listening
 * dispatcher.toRoomy.push(event);
 *
 * // Roomy → Discord: queued, dispatcher distributes to services after Phase 3
 * dispatcher.toDiscord.push(decodedEvent);
 * ```
 */
export function createDispatcher(): EventDispatcher {
  const toRoomy = new AsyncChannel<Event>();
  const toDiscord = new AsyncChannel<{
    decoded?: DecodedStreamEvent;
    batchId: Ulid;
    isLastEvent: boolean;
  }>();

  return {
    toRoomy,
    toDiscord,
  };
}
