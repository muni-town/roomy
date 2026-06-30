/**
 * Drives end-to-end materialisation for a single Roomy space stream.
 *
 * Reads `comp_space.backfilled_to` for the given stream, opens a
 * `ConnectedSpace` subscription starting just past that index, and applies
 * incoming event batches via `applyBatch`. The cursor is advanced inside
 * `applyBatch`, so a crash mid-backfill resumes cleanly on the next start.
 *
 * Backfill and live updates flow through the same code path; the SDK's
 * `EventCallbackMeta.isBackfill` flag is forwarded so the unread-counter
 * patch only fires for live createMessage events.
 */

import { Database } from "bun:sqlite";
import {
  type ConnectedSpace,
  type EventCallback,
  type StreamDid,
  type StreamIndex,
  type Ulid,
  type UserDid,
  decodeTime,
} from "@roomy-space/sdk";

import type { InvalidationRouter } from "../invalidation/types.ts";
import { applyBatch, type MaterializationStats } from "./applyBatch.ts";
import { ensureProfilesForBatch, type GetProfilesFn } from "./profiles.ts";
import { toAppliedEvent } from "./toAppliedEvent.ts";
import {
  isDebugEnabled,
  recordBatchDelivery,
  recordDeliveryGap,
} from "../debug/eventStore.ts";
import { pokeEmbedSweeper } from "../embed/sweeper.ts";
import { pokePushDispatcher } from "../push/dispatcher.ts";
import { log } from "../log.ts";

export type ConnectedSpaceLike = Pick<
  ConnectedSpace,
  "subscribe" | "unsubscribe" | "streamDid"
>;

export interface SpaceMaterializerStartOpts {
  streamDid: StreamDid;
  db: Database;
  /**
   * Resolve the `ConnectedSpace` for this stream. Defaulting is the
   * registry's job — keeping the dependency explicit here makes the class
   * trivially injectable in tests.
   */
  getConnectedSpace: (streamDid: StreamDid) => Promise<ConnectedSpaceLike>;
  /**
   * Bulk profile fetcher (typically `RoomyServiceClient.getProfiles`).
   * Optional so tests can omit it; when omitted, profile prefetch is a no-op
   * and entities for users will be created lazily by individual materialisers.
   */
  getProfiles?: GetProfilesFn;
  /**
   * Invalidation router to notify after events are materialised.
   * Optional so tests can run without one.
   */
  invalidationRouter?: InvalidationRouter;
}

export interface AggregateStats {
  applied: number;
  materializerErrors: number;
  applyErrors: number;
  /** Total batches handled (live + backfill). */
  batches: number;
}

/**
 * Read the persisted cursor for a stream. Returns 0 when no comp_space row
 * exists yet — the first batch will create it via the addAdmin / personal
 * joinSpace materialiser, after which subsequent backfilled_to writes target
 * an existing row.
 */
export function readBackfilledTo(db: Database, streamDid: StreamDid): number {
  const row = db
    .query<
      { backfilled_to: number | null },
      [string]
    >("select backfilled_to from comp_space where entity = ?")
    .get(streamDid);
  return row?.backfilled_to ?? 0;
}

export class SpaceMaterializer {
  readonly streamDid: StreamDid;
  readonly stats: AggregateStats = {
    applied: 0,
    materializerErrors: 0,
    applyErrors: 0,
    batches: 0,
  };

  /** Resolves once the initial backfill completes (or rejects on subscribe failure). */
  readonly backfillDone: Promise<Ulid>;

  /** True once `backfillDone` has settled (resolved or rejected). */
  backfillSettled = false;

  /** If `backfillDone` rejected, the error. Null otherwise. */
  backfillError: unknown = null;

  /**
   * Tracks the highest `idx` seen so far across all batches for this stream.
   * Used to detect delivery gaps that could indicate missing events from the
   * subscription (e.g. due to un-ordered pagination in the module query).
   */
  #lastObservedIdx: StreamIndex = 0 as StreamIndex;
  /** Count of detected idx gaps across all batches for this stream. */
  gapCount = 0;
  /** Total events delivered across all batches for this stream. */
  totalEventsDelivered = 0;

  private readonly db: Database;
  private readonly space: ConnectedSpaceLike;
  private readonly getProfiles: GetProfilesFn | undefined;
  private readonly invalidationRouter: InvalidationRouter | undefined;

  /**
   * Serial chain of in-flight batch processing. Subscriptions deliver events
   * synchronously into `onBatch`, but our processing is now async (profile
   * prefetch). Appending to a single chain preserves idx ordering and
   * provides natural backpressure: if profile fetches stall, subsequent
   * batches queue up rather than racing.
   */
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    db: Database,
    space: ConnectedSpaceLike,
    backfillDone: Promise<Ulid>,
    getProfiles: GetProfilesFn | undefined,
    invalidationRouter: InvalidationRouter | undefined,
  ) {
    this.db = db;
    this.space = space;
    this.streamDid = space.streamDid;
    this.getProfiles = getProfiles;
    this.invalidationRouter = invalidationRouter;

    // Track settlement so callers can check without awaiting.
    this.backfillDone = backfillDone.then(
      (v) => {
        this.backfillSettled = true;
        return v;
      },
      (e) => {
        this.backfillSettled = true;
        this.backfillError = e;
        throw e;
      },
    );

    // The wrapper above re-throws on rejection so awaiters of `backfillDone`
    // (eager backfill, admin materializeSpace, createSpace) see the failure.
    // But the lazy path (userHydration) deliberately does NOT await it — it
    // inspects `backfillSettled`/`backfillError` instead — and
    // `materializeSpace` attaches a `.then` with no rejection handler. An
    // un-awaited rejected promise becomes an unhandled rejection, which Bun
    // surfaces as an error (and fails tests). Attach a no-op rejection
    // handler so the promise is always "observed"; awaiters still receive the
    // rejection independently (each consumer gets its own rejection
    // delivery), and `backfillError` remains the source of truth for the
    // lazy path.
    this.backfillDone.catch(() => {});

    // Log a backfill-completion summary including any delivery gaps detected.
    // Debug, not info: with thousands of spaces this fires once per space at
    // startup (~N lines), which alone can trip platform log-rate limits. The
    // startup backfill driver in index.ts emits a batched progress summary;
    // set LOG_LEVEL=debug to see per-space completion.
    backfillDone.then(
      () => {
        log.debug(
          `[SpaceMaterializer] backfill complete for ${this.streamDid}: ` +
            `total=${this.totalEventsDelivered} gaps=${this.gapCount} ` +
            `applied=${this.stats.applied} matErrors=${this.stats.materializerErrors} ` +
            `applyErrors=${this.stats.applyErrors}`,
        );

        // Backfill detects (but doesn't enrich) links. Poke the centralized
        // embed sweeper so newly backfilled links get enriched promptly.
        pokeEmbedSweeper();
      },
      () => {
        /* already logged by start() */
      },
    );
  }

  /**
   * Start materialising a space. Returns once the underlying Leaf
   * subscription is established; backfill completion is exposed via
   * `backfillDone` so lazy callers can decide whether to wait.
   */
  static async start(
    opts: SpaceMaterializerStartOpts,
  ): Promise<SpaceMaterializer> {
    const cursor = readBackfilledTo(opts.db, opts.streamDid);

    // The very first space-stream events (addAdmin, updateSpaceInfo) write
    // rows whose FKs reference an entity row for the space itself
    // (edges.head, comp_info.entity, comp_space.entity). The frontend never
    // hits this because PersonalJoinSpace seeds the row from the user's
    // personal stream — but on the appserver we only see the space stream,
    // so we have to seed it ourselves before any events apply.
    opts.db.run(
      "insert into entities (id, stream_id, created_at) values (?, ?, ?) on conflict(id) do nothing",
      [opts.streamDid, opts.streamDid, Date.now()],
    );

    const space = await opts.getConnectedSpace(opts.streamDid);

    // Construct first so the callback can close over `inst`.
    let inst!: SpaceMaterializer;
    const callback: EventCallback = (events, meta) =>
      inst.onBatch(events, meta);

    // ConnectedSpace.subscribe() awaits the websocket subscription internally
    // before returning the backfill-done promise, so we can't separate the
    // two phases. Kick the whole thing off and surface the resulting promise.
    const backfillDone = space.subscribe(callback, (cursor + 1) as StreamIndex);

    // Surface unhandled errors so a failed backfill doesn't disappear into a
    // silently-rejected promise.
    backfillDone.catch((err) => {
      log.error(
        `[SpaceMaterializer] backfill failed for ${opts.streamDid}:`,
        err,
      );
    });

    inst = new SpaceMaterializer(
      opts.db,
      space,
      backfillDone,
      opts.getProfiles,
      opts.invalidationRouter,
    );

    return inst;
  }

  /**
   * Subscription callback. Synchronous on the wire (matches `EventCallback`'s
   * void return), but the actual work is enqueued onto a serial chain so
   * profile prefetch awaits don't reorder batches.
   */
  private onBatch(
    events: Parameters<EventCallback>[0],
    meta: Parameters<EventCallback>[1],
  ): void {
    this.chain = this.chain.then(() => this.processBatch(events, meta));
  }

  private async processBatch(
    events: Parameters<EventCallback>[0],
    meta: Parameters<EventCallback>[1],
  ): Promise<void> {
    try {
      await ensureProfilesForBatch(this.db, events, this.getProfiles);
    } catch (err) {
      // Profile prefetch is best-effort — a transient appview outage
      // shouldn't block materialisation. Materialisers' own ensureEntity
      // calls will still create rows for referenced DIDs without profile data.
      log.warn(
        `[SpaceMaterializer] ${this.streamDid} profile prefetch failed:`,
        err,
      );
    }

    // Detect delivery gaps: if events have a min idx higher than lastObservedIdx + 1,
    // events between them were skipped by the subscription.
    // The first batch for a fresh stream starts at idx 0, so the first batch
    // naturally shows a gap from 0 — we only warn once we've seen at least one event.
    const batchMinIdx = events.reduce<number>(
      (min, e) => Math.min(min, e.idx),
      Infinity,
    );
    const batchMaxIdx = events.reduce<number>(
      (max, e) => Math.max(max, e.idx),
      0,
    );
    this.totalEventsDelivered += events.length;

    let gapDetected = false;
    // Snapshot before gap check — used by recordDeliveryGap below.
    const prevLastObservedIdx = this.#lastObservedIdx;
    if (this.#lastObservedIdx > 0 && batchMinIdx > this.#lastObservedIdx + 1) {
      const gapSize = batchMinIdx - this.#lastObservedIdx - 1;
      this.gapCount += gapSize;
      gapDetected = true;
      log.warn(
        `[SpaceMaterializer] ${this.streamDid} delivery gap detected: ` +
          `expected idx ${this.#lastObservedIdx + 1} but batch starts at ${batchMinIdx} ` +
          `(${gapSize} event(s) potentially missing) ` +
          `isBackfill=${meta.isBackfill} totalDelivered=${this.totalEventsDelivered}`,
      );
    }
    if (batchMaxIdx > this.#lastObservedIdx) {
      this.#lastObservedIdx = batchMaxIdx as StreamIndex;
    }

    // Record batch delivery in debug event store, if enabled.
    if (isDebugEnabled()) {
      recordBatchDelivery({
        streamDid: this.streamDid,
        batchId: meta.batchId,
        isBackfill: meta.isBackfill,
        events,
      });
      if (gapDetected) {
        recordDeliveryGap({
          streamDid: this.streamDid,
          gapStart: (prevLastObservedIdx + 1) as StreamIndex,
          gapEnd: (batchMinIdx - 1) as StreamIndex,
          gapSize: batchMinIdx - prevLastObservedIdx - 1,
          isBackfill: meta.isBackfill,
          batchMinIdx: batchMinIdx as StreamIndex,
        });
      }
    }

    const stats = applyBatch(this.db, this.streamDid, events, {
      isBackfill: meta.isBackfill,
    });
    this.stats.applied += stats.applied;
    this.stats.materializerErrors += stats.materializerErrors;
    this.stats.applyErrors += stats.applyErrors;
    this.stats.batches += 1;

    if (stats.materializerErrors || stats.applyErrors) {
      log.warn(
        `[SpaceMaterializer] ${this.streamDid} batch: applied=${stats.applied} matErrors=${stats.materializerErrors} applyErrors=${stats.applyErrors} (isBackfill=${meta.isBackfill})`,
      );
    }

    // For live batches, materialise the applied-event view once and reuse it
    // for both the embed-sweeper poke and the push dispatcher poke (below).
    // Backfill is skipped for both — same gate as the unread-counter increment.
    const isLive = !meta.isBackfill;
    const applied = isLive
      ? events.map((e) => toAppliedEvent(e, this.streamDid))
      : [];

    // Poke the centralized embed sweeper when live batches add messages —
    // that's when detectAndStoreLinks (called inside applyBatch) creates new
    // pending link rows. We pass the freshly-detected URLs so the sweeper
    // prioritises them over the backfill backlog — a newly posted link gets
    // enriched within seconds instead of waiting behind thousands of
    // historical pending links. Backfill is skipped here; it pokes once on
    // completion (no priority URLs). pokeEmbedSweeper() is a no-op if a sweep
    // is already draining, so calling it on every relevant batch is cheap.
    if (
      isLive &&
      events.some(
        (e) => e.event.$type === "space.roomy.message.createMessage.v0",
      )
    ) {
      pokeEmbedSweeper(stats.detectedLinks);
    }

    // Poke the centralized push dispatcher for live createMessage events.
    // The dispatcher runs all recipient resolution + network delivery in the
    // background so push never blocks materialisation (same pattern as the
    // embed sweeper). pokePushDispatcher() is a no-op if the loop is busy
    // draining, so calling it on every relevant batch is cheap. (Phase 1:
    // Busy immediate pushes; the Engaged digest is added in Phase 2.)
    if (
      isLive &&
      events.some(
        (e) => e.event.$type === "space.roomy.message.createMessage.v0",
      )
    ) {
      const pushJobs = applied
        .filter((e) => e.type === "space.roomy.message.createMessage.v0")
        .filter((e) => e.roomId !== undefined)
        .map((e) => ({
          spaceId: this.streamDid,
          roomId: e.roomId!,
          messageId: e.id,
          authorDid: (e.details?.authorDid ?? e.user) as UserDid,
          timestamp: decodeTime(e.id),
        }));
      if (pushJobs.length > 0) pokePushDispatcher(pushJobs);
    }

    // Notify invalidation router (only for live events).
    if (this.invalidationRouter && isLive) {
      this.invalidationRouter.onEventsApplied(this.streamDid, applied, {
        isBackfill: meta.isBackfill,
      });
    }
  }

  /**
   * Resolves once all currently-queued batches have finished processing.
   * Useful for tests that emit synchronously and then want to assert state.
   */
  async drain(): Promise<void> {
    await this.chain;
  }

  /** Aggregate per-batch stats for ops/inspection. */
  getStats(): Readonly<AggregateStats> {
    return { ...this.stats };
  }

  /**
   * Close the materializer: drain any in-flight batches, unsubscribe from
   * the Leaf stream subscription, and release resources. After calling this
   * the materializer is no longer usable.
   */
  async close(): Promise<void> {
    await this.drain();
    await this.space.unsubscribe();
  }
}

export interface MaterializationStatsBatch extends MaterializationStats {}
