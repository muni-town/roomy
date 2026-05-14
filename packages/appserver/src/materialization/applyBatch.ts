/**
 * Apply a batch of decoded events to the database.
 *
 * Single transaction per batch, per-event savepoint inside (so one failing
 * event doesn't roll back the rest). Advances `comp_space.backfilled_to`
 * once at the end. Returns counts plus a bounded list of failures so the
 * caller can surface them without unbounded memory growth.
 *
 * Note: dependency stash/unstash from the frontend worker is intentionally
 * absent. The appserver consumes a single Leaf subscription in monotonically
 * increasing `idx` order, so by the time event N arrives every event it
 * could depend on is already applied.
 */

import { Database } from "bun:sqlite";
import type {
  DecodedStreamEvent,
  StreamDid,
  StreamIndex,
  Ulid,
} from "@roomy-space/sdk";

import { materialize } from "./materializer.ts";
import { applyBundle } from "./applyBundle.ts";

const MAX_TRACKED_FAILURES = 100;

export interface ApplyBatchOpts {
  /** True for backfill events — skips the unread-counter increment. */
  isBackfill: boolean;
}

export interface MaterializationStats {
  applied: number;
  /** SDK materialiser threw or no handler is registered for this $type. */
  materializerErrors: number;
  /** A SQL statement threw while applying the bundle. */
  applyErrors: number;
  /** Up to MAX_TRACKED_FAILURES recent failures, for ops/inspection. */
  failed: Array<{
    eventId: Ulid;
    type: string;
    reason: "materializer" | "apply";
    message: string;
  }>;
}

export function applyBatch(
  db: Database,
  streamId: StreamDid,
  events: DecodedStreamEvent[],
  opts: ApplyBatchOpts,
): MaterializationStats {
  const stats: MaterializationStats = {
    applied: 0,
    materializerErrors: 0,
    applyErrors: 0,
    failed: [],
  };

  if (events.length === 0) return stats;

  let latestIdx: StreamIndex = 0 as StreamIndex;
  for (const e of events) {
    if (e.idx > latestIdx) latestIdx = e.idx;
  }

  // bun:sqlite's Database.transaction(fn) returns a function; calling it
  // wraps `fn` in BEGIN/COMMIT (with rollback on throw).
  const run = db.transaction(() => {
    for (const e of events) {
      const bundle = materialize(e.event, { streamId, user: e.user }, e.idx);

      // console.log("bundle: ", bundle)

      if (bundle.status === "error") {
        stats.materializerErrors++;
        recordFailure(stats, {
          eventId: bundle.eventId,
          type: e.event.$type,
          reason: "materializer",
          message: bundle.message,
        });
        continue;
      }

      try {
        applyBundle(db, bundle, { isBackfill: opts.isBackfill, streamId });
        stats.applied++;
      } catch (err) {
        stats.applyErrors++;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[materialize] apply failed for ${e.event.$type} ${e.event.id} (idx ${e.idx}) on stream ${streamId}: ${message}`,
        );
        recordFailure(stats, {
          eventId: e.event.id,
          type: e.event.$type,
          reason: "apply",
          message,
        });
      }
    }

    // Advance the cursor only on existing comp_space rows. The space row
    // itself is created by the addAdmin / first space event materialiser, so
    // we don't insert here (its `entity` FK to entities would also fail).
    // Match the frontend's monotonic guard so reorderings can't move it back.
    db.prepare(
      `update comp_space
       set backfilled_to = ?,
           updated_at = (unixepoch() * 1000)
       where entity = ?
         and (backfilled_to is null or backfilled_to < ?)`,
    ).run(latestIdx, streamId, latestIdx);
  });

  run();
  return stats;
}

function recordFailure(
  stats: MaterializationStats,
  failure: MaterializationStats["failed"][number],
): void {
  if (stats.failed.length < MAX_TRACKED_FAILURES) {
    stats.failed.push(failure);
  }
}
