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
} from "@roomy-space/sdk";

import { applyBatch, type MaterializationStats } from "./applyBatch.ts";
import { ensureProfilesForBatch, type GetProfilesFn } from "./profiles.ts";

export type ConnectedSpaceLike = Pick<ConnectedSpace, "subscribe" | "streamDid">;

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
    .query<{ backfilled_to: number | null }, [string]>(
      "select backfilled_to from comp_space where entity = ?",
    )
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

  private readonly db: Database;
  private readonly space: ConnectedSpaceLike;
  private readonly getProfiles: GetProfilesFn | undefined;

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
  ) {
    this.db = db;
    this.space = space;
    this.streamDid = space.streamDid;
    this.backfillDone = backfillDone;
    this.getProfiles = getProfiles;
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
    const space = await opts.getConnectedSpace(opts.streamDid);

    // Construct first so the callback can close over `inst`.
    let inst!: SpaceMaterializer;
    const callback: EventCallback = (events, meta) => inst.onBatch(events, meta);

    // ConnectedSpace.subscribe() awaits the websocket subscription internally
    // before returning the backfill-done promise, so we can't separate the
    // two phases. Kick the whole thing off and surface the resulting promise.
    const backfillDone = space.subscribe(
      callback,
      (cursor + 1) as StreamIndex,
    );

    // Surface unhandled errors so a failed backfill doesn't disappear into a
    // silently-rejected promise.
    backfillDone.catch((err) => {
      console.error(
        `[SpaceMaterializer] backfill failed for ${opts.streamDid}:`,
        err,
      );
    });

    inst = new SpaceMaterializer(opts.db, space, backfillDone, opts.getProfiles);
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
      console.warn(
        `[SpaceMaterializer] ${this.streamDid} profile prefetch failed:`,
        err,
      );
    }

    const stats = applyBatch(this.db, this.streamDid, events, {
      isBackfill: meta.isBackfill,
    });
    this.stats.applied += stats.applied;
    this.stats.materializerErrors += stats.materializerErrors;
    this.stats.applyErrors += stats.applyErrors;
    this.stats.batches += 1;

    if (stats.materializerErrors || stats.applyErrors) {
      console.warn(
        `[SpaceMaterializer] ${this.streamDid} batch: applied=${stats.applied} matErrors=${stats.materializerErrors} applyErrors=${stats.applyErrors} (isBackfill=${meta.isBackfill})`,
      );
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
}

export interface MaterializationStatsBatch extends MaterializationStats {}
