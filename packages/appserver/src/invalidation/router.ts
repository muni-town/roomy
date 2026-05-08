/**
 * InvalidationRouter: typed pub/sub bus for invalidation signals.
 *
 * Usage:
 *   1. Create a singleton router.
 *   2. Pass it to SpaceMaterializer (which calls `onEventsApplied` after
 *      each batch).
 *   3. Consumers (WS handler, server cache) call `subscribe`.
 *
 * The router is synchronous — `onEventsApplied` collects signals and
 * dispatches them to listeners inline. This keeps the overhead per event
 * minimal (pure function call + array push) and avoids any async scheduling
 * complexity. Listeners that need async work (WS send, cache I/O) should
 * enqueue and process on their own microtask queue.
 */

import type {
  InvalidationEvent,
  InvalidationListener,
  InvalidationRouter as IInvalidationRouter,
  AppliedEvent,
} from "./types.ts";
import { inferSignals } from "./inferSignals.ts";

export class Router implements IInvalidationRouter {
  readonly #listeners = new Set<InvalidationListener>();
  #seq = 0;

  onEventsApplied(
    streamDid: import("@roomy-space/sdk").StreamDid,
    events: AppliedEvent[],
    meta: { isBackfill: boolean },
  ): void {
    // During backfill, no subscribers care about historical data.
    // Suppress to avoid flooding WS connections on first connect.
    if (meta.isBackfill) return;

    if (this.#listeners.size === 0) return;

    const allSignals: InvalidationEvent[] = [];
    for (const event of events) {
      // Stamp a monotonically increasing seq for message diffs (cursor replay).
      const signals = inferSignals(event);
      for (const signal of signals) {
        if (signal.kind === "messageDiff") {
          signal.signal.seq = ++this.#seq;
        }
      }
      allSignals.push(...signals);
    }

    if (allSignals.length === 0) return;

    // Dispatch to all listeners. If a listener throws, log and continue —
    // one broken consumer shouldn't stop others from receiving signals.
    for (const listener of this.#listeners) {
      try {
        listener(allSignals);
      } catch (err) {
        console.error("[InvalidationRouter] listener threw:", err);
      }
    }
  }

  subscribe(listener: InvalidationListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Current sequence number (for testing / diagnostics). */
  get currentSeq(): number {
    return this.#seq;
  }
}
