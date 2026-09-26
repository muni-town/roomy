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
import { syncMentionsIndex, resolveReplyToAuthors } from "../queries/mentions.ts";
import { openSpaceDb } from "../db/db.ts";
import { log } from "../log.ts";

export class Router implements IInvalidationRouter {
  readonly #listeners = new Set<InvalidationListener>();

  // ─── Singleton accessor ──────────────────────────────────────────

  static #instance: Router | undefined;

  /** Set the process-wide router. Called once from createAppserver(). */
  static setInstance(router: Router): void {
    Router.#instance = router;
  }

  /** Get the process-wide router. Handlers call this to emit signals. */
  static getInstance(): Router | undefined {
    return Router.#instance;
  }

  /** Clear the process-wide router. Called from appserver close() so tests
   *  that spin up a fresh appserver per case don't see a stale singleton. */
  static resetInstance(): void {
    Router.#instance = undefined;
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
    const messageSnapshots = await this.#fetchMessageSnapshots(streamDid, events);

    // Resolve reply-edge authors (depth-1 replies) once per batch, not per
    // event — a single batched per-space query per stream keeps the write
    // path batch-friendly (the 'reply' edge isn't on the AppliedEvent; it's
    // materialised into the per-space DB by applyBatch). Shared by the
    // mentions index (syncMentionsIndex) and the mentionDiff signals
    // (inferSignals).
    const spaceDb = (db as { forSpace?: (d: string) => DbLike } | undefined)?.forSpace?.(streamDid);
    const replyToAuthors = spaceDb
      ? await resolveReplyToAuthors(
          spaceDb,
          events
            .filter((e) =>
              e.type === "space.roomy.message.createMessage.v0" ||
              e.type === "space.roomy.message.forwardMessages.v0" ||
              e.type === "space.roomy.message.editMessage.v0",
            )
            .map((e) =>
              e.type === "space.roomy.message.editMessage.v0"
                ? ((e.details?.messageId as Ulid | undefined) ?? e.id)
                : e.id,
            ),
        )
      : undefined;

    // Dual-write the global mentions index so the `mentions:<did>` sync topic
    // can backfill and deleteMessage can resolve a deleted message's DIDs.
    const globalDb = (db as { global?: () => DbLike } | undefined)?.global?.();
    if (globalDb) {
      await syncMentionsIndex(globalDb, events, { spaceDb, replyToAuthors });
    }

    // Collect per-event signals; deduplicate below across the batch.
    const collected: InvalidationEvent[] = [];
    for (const event of events) {
      collected.push(
        ...(await inferSignals(event, undefined, messageSnapshots, replyToAuthors)),
      );
    }

    // Deduplicate identical signals across the batch. A `sendEvents` call
    // carrying N events of the same type (e.g. N deletes) produces N copies
    // of every batch-level signal each handler emits — N identical
    // `getActivityFeed` broadcasts, N `getThreads` broadcasts, and so on.
    // See `dedupeSignals`: only identity-keyed query invalidations collapse;
    // per-message diffs and unread deltas pass through untouched.
    const allSignals = dedupeSignals(collected);
    if (allSignals.length === 0) return;
    for (const listener of this.#listeners) {
      try {
        listener(allSignals);
      } catch (err) {
        log.error("[InvalidationRouter] listener threw:", err);
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
    streamDid: StreamDid,
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
        // moveMessages: the diff carries the moved messages into the
        // destination room, keyed by their own ids (surfaced by
        // `toAppliedEvent` as `details.messageIds`). Reading them back
        // post-materialization yields the row with its NEW `room`, which is
        // what the destination `add` op must carry.
        case "space.roomy.message.moveMessages.v0": {
          const messageIds = event.details?.messageIds as Ulid[] | undefined;
          if (Array.isArray(messageIds)) {
            for (const id of messageIds) if (id) ids.add(id);
          }
          break;
        }
      }
    }
    if (ids.size === 0) return new Map();
    // Internal read: the diff handlers need the message's own fields, not a
    // rendered message, so skip the profile-hydration pass. This runs inside
    // `StreamManager.sendEvents` (via `onEventsApplied`), and hydration can
    // issue an on-demand Bluesky/HappyView fetch — a network round-trip
    // inside the write path. The client receives the author via the WS diff
    // and resolves the profile itself.
    const { messages } = await selectMessages(db ?? openSpaceDb(streamDid), {
      kind: "ids",
      ids: [...ids],
      skipProfileHydration: true,
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
   * Emit invalidation signals directly (not from event processing).
   * Used by procedure handlers that mutate appserver-local state.
   */
  emit(signals: readonly InvalidationEvent[]): void {
    if (signals.length === 0 || this.#listeners.size === 0) return;
    // One `emit` call is one coalescing scope, exactly like one
    // `onEventsApplied` batch — a caller that hands us the same invalidation
    // N times (e.g. one per enriched message) must not broadcast it N times.
    const deduped = dedupeSignals(signals);
    for (const listener of this.#listeners) {
      try {
        listener(deduped);
      } catch (err) {
        log.error("[InvalidationRouter] listener threw:", err);
      }
    }
  }
}

/**
 * Collapse duplicate signals within one emission scope.
 * A batch of N events of the same type makes `inferSignals` emit N copies of
 * every batch-level signal (the same `getActivityFeed` / `getThreads` /
 * `getSpaces` invalidation). The WS handler turns each copy into a frame per
 * connection, so N duplicates become N broadcasts of identical bytes and N
 * client-side refetch storms.
 *
 * Only `queryInvalidation` signals collapse, keyed by their full identity
 * `(nsid, params, affectedUser)`: that is what "this query result is stale"
 * means, and a duplicate says exactly the same thing again. Everything else is
 * per-event data and passes through untouched —
 *   - `messageDiff`/`mentionDiff` are per-message ops (and carry a unique seq),
 *   - `roomMetadataDiff` carries an unread DELTA: two creates each mean +1, so
 *     collapsing them by (space, room) would silently lose an increment.
 * Restricting the dedup to identity-keyed invalidations makes that class of
 * bug unrepresentable rather than relying on the seq stamp to keep them apart.
 *
 * Order is preserved: the first occurrence of each distinct invalidation is
 * kept, and non-invalidation signals stay exactly where they were.
 */
export function dedupeSignals(
  signals: readonly InvalidationEvent[],
): InvalidationEvent[] {
  if (signals.length < 2) return [...signals];
  const seen = new Set<string>();
  /** Index of the kept activity diff for each (space, room) — see below. */
  const activityAt = new Map<string, number>();
  const out: InvalidationEvent[] = [];
  for (const signal of signals) {
    if (signal.kind === "queryInvalidation") {
      const key = `${signal.signal.nsid}\u0000${signal.signal.affectedUser ?? ""}\u0000${canonicalParams(signal.signal.params)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(signal);
      continue;
    }
    // `roomActivityDiff` is a superseding STATE SNAPSHOT — the board row as it
    // stands after this message — not an incremental op. A batch of N messages
    // in one room therefore emits N snapshots of which only the last is true
    // (the room's newest activity wins), so keep the last per (space, room),
    // replacing the earlier one IN PLACE to preserve emission order.
    //
    // This is safe for exactly the reason `roomMetadataDiff` is exempt: that
    // frame carries a DELTA, where dropping one would silently lose an
    // increment, whereas dropping a superseded snapshot loses nothing.
    if (signal.kind === "roomActivityDiff") {
      const { spaceId, roomId } = signal.signal;
      const key = `${spaceId}\u0000${roomId}`;
      const at = activityAt.get(key);
      if (at === undefined) {
        activityAt.set(key, out.length);
        out.push(signal);
      } else {
        out[at] = signal;
      }
      continue;
    }
    out.push(signal);
  }
  return out;
}

/** Deterministic param serialization: key order must not change the identity. */
function canonicalParams(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let out = "";
  for (const key of keys) out += `${key}=${params[key]}\u0001`;
  return out;
}
