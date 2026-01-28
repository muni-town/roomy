import type { ConnectedSpace } from "@roomy/sdk";
import type { Event } from "@roomy/sdk";

const DEFAULT_BATCH_SIZE = 100;

/**
 * Batches events for efficient sending to the Leaf server.
 * Events are queued and sent in batches of up to 100 (configurable).
 */
export class EventBatcher {
  #connectedSpace: ConnectedSpace;
  #queue: Event[] = [];
  #batchSize: number;

  constructor(connectedSpace: ConnectedSpace, batchSize = DEFAULT_BATCH_SIZE) {
    this.#connectedSpace = connectedSpace;
    this.#batchSize = batchSize;
  }

  /**
   * Add an event to the queue. Flushes automatically when batch size is reached.
   */
  async add(event: Event): Promise<void> {
    this.#queue.push(event);
    if (this.#queue.length >= this.#batchSize) {
      await this.flush();
    }
  }

  /**
   * Send all queued events to the server.
   */
  async flush(): Promise<void> {
    if (this.#queue.length === 0) return;

    const events = this.#queue;
    this.#queue = [];

    console.log(`Flushing batch of ${events.length} events`);
    await this.#connectedSpace.sendEvents(events);
  }

  /**
   * Number of events currently queued.
   */
  get queueSize(): number {
    return this.#queue.length;
  }
}
