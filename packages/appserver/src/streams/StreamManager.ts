import {
  type DecodedStreamEvent,
  type Event,
  type StreamDid,
  type StreamIndex,
  type UserDid,
  newUlid,
  parseEvent,
} from "@roomy-space/sdk";
import { encode, decode } from "@atcute/cbor";
import type { DbLike } from "../db/types.ts";
import type { InvalidationRouter } from "../invalidation/types.ts";
import { applyBatch } from "../materialization/applyBatch.ts";
import {
  defaultGetProfiles,
  ensureProfilesForBatch,
  type GetProfilesFn,
} from "../materialization/profiles.ts";
import { toAppliedEvent } from "../materialization/toAppliedEvent.ts";
import { pokeEmbedSweeper } from "../embed/sweeper.ts";
import { pokePushDispatcher } from "../push/dispatcher.ts";
import { decodeTime } from "ulidx";
import { createStreamDid } from "./did.ts";

/**
 * Singleton StreamManager — writes events directly to the events DB,
 * materializes inline, and emits invalidation signals.
 */
export type StreamEventListener = (
  streamDid: StreamDid,
  events: readonly DecodedStreamEvent[],
) => void;

/**
 * Singleton StreamManager — writes events directly to the events DB,
 * materializes inline, and emits invalidation signals.
 */
export class StreamManager {
  readonly #db: DbLike;
  readonly #invalidationRouter?: InvalidationRouter;
  readonly #appserverUrl: string;
  readonly #getProfiles?: GetProfilesFn;
  /** Live-event listeners, notified after each sendEvents batch. */
  readonly #streamListeners = new Set<StreamEventListener>();

  /**
   * Per-stream serialization queues. Concurrent sendEvents to the same
   * stream chain off each other so the post-insert section (decode →
   * materialize → invalidate → listeners) runs strictly in idx order.
   * Different streams run in parallel. Entries are cleaned up once the
   * queue drains.
   */
  readonly #streamQueues = new Map<string, Promise<void>>();

  constructor(
    db: DbLike,
    opts: {
      invalidationRouter?: InvalidationRouter;
      appserverUrl: string;
      getProfiles?: GetProfilesFn;
    },
  ) {
    this.#db = db;
    this.#invalidationRouter = opts.invalidationRouter;
    this.#appserverUrl = opts.appserverUrl;
    this.#getProfiles = opts.getProfiles ?? defaultGetProfiles;
  }

  /**
   * Run `fn` strictly after any prior serialized work for the same stream.
   * Uses a chain-of-promises mutex keyed by streamDid so different streams
   * never block each other. The next link always runs even if the previous
   * rejected, and the queue entry is removed once it is the tail (no leak).
   */
  async #runSerialized(
    streamDid: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev = this.#streamQueues.get(streamDid) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run even if prev rejected
    this.#streamQueues.set(streamDid, next);
    next.finally(() => {
      if (this.#streamQueues.get(streamDid) === next) {
        this.#streamQueues.delete(streamDid);
      }
    });
    return next;
  }

  /**
   * Send events to a stream: write to events DB, materialize inline,
   * emit invalidation signals.
   *
   * The SELECT MAX(idx), INSERTs, and stream_state upsert run in a single
   * SQLite transaction so concurrent sendEvents calls cannot collide on
   * idx assignment.
   */
  async sendEvents(
    streamDid: StreamDid,
    events: Event[],
    userOverride?: string,
  ): Promise<void> {
    // 1. Encode each event to CBOR bytes
    const encoded = events.map((event) => encode(event));

    // 2. Assign sequential idx values and insert atomically.
    //    Each INSERT uses INSERT ... SELECT to compute its idx from
    //    max(idx) at the moment of insertion. Since all steps run in a
    //    single worker transaction, each subsequent INSERT sees the
    //    previous INSERT's row, producing sequential idx values.
    const user = userOverride ?? "unknown";
    const steps: Array<{
      type: "query" | "run" | "exec";
      sql: string;
      params?: unknown[];
    }> = [];

    for (let i = 0; i < encoded.length; i++) {
      steps.push({
        type: "run",
        sql: "insert into events.stream_events (stream_id, idx, user, payload, signature) select ?, coalesce(max(idx), -1) + 1, ?, ?, x'' from events.stream_events where stream_id = ?",
        params: [streamDid, user, encoded[i] as Uint8Array, streamDid],
      });
    }

    // Update stream_state with the latest idx
    steps.push({
      type: "run",
      sql: "insert into events.stream_state (stream_id, latest_event) select ?, coalesce(max(idx), -1) from events.stream_events where stream_id = ? on conflict (stream_id) do update set latest_event = excluded.latest_event",
      params: [streamDid, streamDid],
    });

    // Final step: return the startIdx we just used
    steps.push({
      type: "query",
      sql: "select coalesce(max(idx), -1) + 1 - ? as start_idx from events.stream_events where stream_id = ?",
      params: [encoded.length, streamDid],
    });

    const result = await this.#db.transaction<Array<{ start_idx: number }>>(steps);
    const startIdx = (result?.[0]?.start_idx ?? 0) as number;

    // Serialize the post-insert section per stream so concurrent
    // sendEvents to the same stream materialize strictly in idx order.
    // The idx assignment above is already atomic; this guards the async
    // gap between insert and materialize (decode → materialize →
    // invalidate → listeners). Different streams are not serialized.
    await this.#runSerialized(streamDid, async () => {
      // 3. Decode events back to DecodedStreamEvent[]
      const decodedEvents: DecodedStreamEvent[] = encoded.map(
        (bytes, i): DecodedStreamEvent => ({
          idx: (startIdx + i) as StreamIndex,
          event: decode(bytes) as Event,
          user: (userOverride ?? "unknown") as UserDid,
        }),
      );

      // 4. Ensure profiles for batch
      await ensureProfilesForBatch(this.#db, decodedEvents, this.#getProfiles);

      // 5. Apply batch to materialize
      await applyBatch(this.#db, streamDid, decodedEvents, {
        isBackfill: false,
      });

      // 6. Convert to applied events once — shared by invalidation (6a) and
      //    the push dispatcher poke (6b).
      const appliedEvents = decodedEvents.map((e) => toAppliedEvent(e, streamDid));

      // 6a. Emit invalidation signals for live events.
      if (this.#invalidationRouter) {
        await this.#invalidationRouter.onEventsApplied(
          streamDid,
          appliedEvents,
          { isBackfill: false },
          this.#db,
        );
      }

      // 6b. Poke the embed sweeper and the push dispatcher for createMessage
      // events. Both are process-wide background loops the materialiser pokes
      // but never drives inline: embed enrichment and push delivery are
      // network-bound and must not block sendEvents. sendEvents is only ever
      // called with live events (the StreamManager owns the only write path),
      // so there is no backfill gate here.
      const createMessageEvents = appliedEvents.filter(
        (e) =>
          e.type === "space.roomy.message.createMessage.v0" &&
          e.roomId !== undefined,
      );
      if (createMessageEvents.length > 0) {
        pokeEmbedSweeper();
        pokePushDispatcher(
          createMessageEvents.map((e) => ({
            spaceId: streamDid,
            roomId: e.roomId!,
            messageId: e.id,
            authorDid: (e.details?.authorDid ?? e.user) as UserDid,
            timestamp: decodeTime(e.id),
            mentions: e.details?.mentions as string[] | undefined,
          })),
        );
      }

      // 8. Notify live-event listeners (e.g. sync stream subscriptions).
      if (this.#streamListeners.size > 0) {
        for (const listener of this.#streamListeners) {
          try {
            listener(streamDid, decodedEvents);
          } catch (err) {
            console.error(
              `StreamEventListener threw for ${streamDid}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    });
  }

  /**
   * Create a new stream locally: register DID, write addAdmin event.
   * The caller is responsible for sending seed events via sendEvents().
   *
   * Note: PLC directory registration is irreversible — once the DID is
   * registered at plc.directory it cannot be rolled back. If subsequent
   * steps fail, the entities row is deleted (best-effort) but the PLC
   * operation stands.
   */
  async createStream(adminDid: UserDid): Promise<StreamDid> {
    // 1. Register a new DID PLC (irreversible)
    const streamDid = await createStreamDid(
      this.#appserverUrl,
      adminDid,
      this.#db,
    );

    try {
      // 2. Insert space entity row (before addAdmin so materialization FK resolves)
      await this.#db.run(
        "insert into entities (id, stream_id) values (?, ?)",
        streamDid,
        streamDid,
      );

      // 3. Write and materialize addAdmin event
      const addAdminResult = parseEvent({
        id: newUlid(),
        $type: "space.roomy.space.addAdmin.v0",
        userDid: adminDid,
      });
      if (!addAdminResult.success) {
        throw new Error(`Failed to create addAdmin event: ${addAdminResult.error}`);
      }
      await this.sendEvents(streamDid, [addAdminResult.data], adminDid);
    } catch (err) {
      // Best-effort cleanup: remove the entities row. PLC registration
      // cannot be rolled back.
      await this.#db.run("delete from entities where id = ?", streamDid);
      throw err;
    }

    return streamDid;
  }

  /**
   * Get the latest event index for a stream.
   */
  async getLatestEventIdx(streamDid: StreamDid): Promise<StreamIndex> {
    const row = await this.#db
      .query(
        "select latest_event from events.stream_state where stream_id = ?",
      )
      .get<{ latest_event: number }>(streamDid);
    return (row?.latest_event ?? 0) as StreamIndex;
  }

  /**
   * Register a live-event listener. Called after each `sendEvents` batch
   * is committed. Used by the sync system to push raw events to stream
   * subscribers. Returns an unsubscribe function.
   */
  onEvents(listener: StreamEventListener): () => void {
    this.#streamListeners.add(listener);
    return () => this.#streamListeners.delete(listener);
  }

  /**
   * Fetch raw events for a stream strictly after `cursor` (exclusive),
   * up to `limit`. Used by the sync system to backfill stream subscribers
   * from a persisted cursor on (re)connect.
   *
   * Returns the events and the new cursor (the last returned idx, or the
   * input cursor if no rows).
   */
  async getEventsFrom(
    streamDid: StreamDid,
    cursor: number,
    limit: number,
  ): Promise<{ events: DecodedStreamEvent[]; cursor: number }> {
    const rows = await this.#db
      .query(
        "select idx, user, payload from events.stream_events where stream_id = ? and idx > ? order by idx limit ?",
      )
      .all<{ idx: number; user: string; payload: Uint8Array }>(
        streamDid,
        cursor,
        limit,
      );
    const events = rows.map((r): DecodedStreamEvent => ({
      idx: r.idx as StreamIndex,
      event: decode(r.payload) as Event,
      user: r.user as UserDid,
    }));
    const newCursor = rows.length > 0 ? rows[rows.length - 1]!.idx : cursor;
    return { events, cursor: newCursor };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: StreamManager | null = null;

/**
 * Set the process-wide StreamManager singleton. Called once at startup.
 */
export function setStreamManager(sm: StreamManager): void {
  instance = sm;
}

/**
 * Get the process-wide StreamManager singleton, or throw if not yet set.
 */
export function getStreamManager(): StreamManager {
  if (!instance) {
    throw new Error("StreamManager not initialized");
  }
  return instance;
}

/**
 * Reset the singleton (tests only).
 */
export function _resetStreamManager(): void {
  instance = null;
}
