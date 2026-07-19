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
import type { DbLike } from "../db/types.ts";
import type { StreamDid, Ulid } from "@roomy-space/sdk";
import { inferSignals } from "./inferSignals.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { openDb } from "../db/db.ts";

export class Router implements IInvalidationRouter {
  readonly #listeners = new Set<InvalidationListener>();
  #seq = 0;

  // ─── Singleton accessor ──────────────────────────────────────────

  static #instance: Router | undefined;

  /** Set the process-wide router. Called once from index.ts. */
  static setInstance(router: Router): void {
    Router.#instance = router;
  }

  /** Get the process-wide router. Handlers call this to emit signals. */
  static getInstance(): Router | undefined {
    return Router.#instance;
  }

  async onEventsApplied(
    streamDid: StreamDid,
    events: AppliedEvent[],
    meta: { isBackfill: boolean },
    db?: DbLike,
  ): Promise<void> {
    if (meta.isBackfill) return;
    if (this.#listeners.size === 0) return;

    // Pre-fetch every message row the batch's handlers will reference, in a
    // single `selectMessages` call. createMessage / forwardMessages key the
    // messageDiff by `event.id`; editMessage keys it by `details.messageId`.
    // Without batching, `inferSignals` would issue 5 queries per message
    // event (5N for a batch of N); this collapses them to 5 queries total.
    const messageSnapshots = await this.#fetchMessageSnapshots(events, db);

    const allSignals: InvalidationEvent[] = [];
    for (const event of events) {
      const signals = await inferSignals(event, db, messageSnapshots);
      for (const signal of signals) {
        if (signal.kind === "messageDiff" || signal.kind === "roomMetadataDiff") {
          signal.signal.seq = ++this.#seq;
        }
      }
      allSignals.push(...signals);
    }
    if (allSignals.length === 0) return;
    for (const listener of this.#listeners) {
      try {
        listener(allSignals);
      } catch (err) {
        console.error("[InvalidationRouter] listener threw:", err);
      }
    }
  }

  /**
   * Collect the message ids a batch's handlers will read, fetch them all in
   * one `selectMessages` call, and return them keyed by message id. Returns
   * an empty map when the batch has no message-shaped events so the per-event
   * fallback path stays a no-op.
   */
  async #fetchMessageSnapshots(
    events: readonly AppliedEvent[],
    db?: DbLike,
  ): Promise<ReadonlyMap<Ulid, MessageDto>> {
    const ids = new Set<Ulid>();
    for (const event of events) {
      switch (event.type) {
        // createMessage and forwardMessages: the message entity id is the
        // event id (the messageDiff `add` op is keyed by it).
        case "space.roomy.message.createMessage.v0":
        case "space.roomy.message.forwardMessages.v0":
          if (event.roomId) ids.add(event.id);
          break;
        // editMessage: the diff targets the original message, keyed by
        // `details.messageId` (surfaced by `toAppliedEvent`).
        case "space.roomy.message.editMessage.v0": {
          const messageId = event.details?.messageId as Ulid | undefined;
          if (messageId) ids.add(messageId);
          break;
        }
      }
    }
    if (ids.size === 0) return new Map();
    const { messages } = await selectMessages(db ?? openDb(), {
      kind: "ids",
      ids: [...ids],
    });
    return new Map(messages.map((m) => [m.id as Ulid, m] as const));
  }

  subscribe(listener: InvalidationListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Emit invalidation signals directly (not from Leaf events).
   * Used by procedure handlers that mutate appserver-local state.
   */
  emit(signals: readonly InvalidationEvent[]): void {
    if (signals.length === 0 || this.#listeners.size === 0) return;
    for (const listener of this.#listeners) {
      try {
        listener(signals);
      } catch (err) {
        console.error("[InvalidationRouter] listener threw:", err);
      }
    }
  }

  /** Current sequence number (for testing / diagnostics). */
  get currentSeq(): number {
    return this.#seq;
  }
}
