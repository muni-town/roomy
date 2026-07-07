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

import type { DbLike } from "../db/types.ts";
import type {
  DecodedStreamEvent,
  StreamDid,
  StreamIndex,
  Ulid,
} from "@roomy-space/sdk";

import { materialize } from "./materializer.ts";
import { applyBundle } from "./applyBundle.ts";
import {
  isDebugEnabled,
  recordMaterialization,
} from "../debug/eventStore.ts";
import { detectAndStoreLinks } from "../embed/enricher.ts";
import { decodeContent } from "../db/content.ts";

import { log } from "../log.ts";
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
  /**
   * Link URLs newly detected in this batch's createMessage events (inserted
   * into `comp_embed_link` by `detectAndStoreLinks`). The SpaceMaterializer
   * passes these to `pokeEmbedSweeper` so freshly-posted links are enriched
   * with priority over the backfill backlog. Empty for batches without
   * new link-bearing messages.
   */
  detectedLinks: string[];
}

export async function applyBatch(
  db: DbLike,
  streamId: StreamDid,
  events: DecodedStreamEvent[],
  opts: ApplyBatchOpts,
): Promise<MaterializationStats> {
  const stats: MaterializationStats = {
    applied: 0,
    materializerErrors: 0,
    applyErrors: 0,
    failed: [],
    detectedLinks: [],
  };

  if (events.length === 0) return stats;

  let latestIdx: StreamIndex = 0 as StreamIndex;
  for (const e of events) {
    if (e.idx > latestIdx) latestIdx = e.idx;
  }

  // Build transaction steps: bundle statements + cursor advance.
  // Side-effects (sortIdx, activityItem, link detection) run outside the
  // transaction since they're idempotent and don't need atomicity with the
  // main bundle application.
  const steps: Array<{ type: "query" | "run" | "exec"; sql: string; params?: unknown[] }> = [];

  const total = events.length;
  // Log progress at 10% intervals, minimum every 500 events
  const logInterval = Math.max(500, Math.round(total / 10));
  let nextLogAt = logInterval;

  for (const e of events) {
    const bundle = materialize(e.event, { streamId, user: e.user }, e.idx);

    if (bundle.status === "error") {
      stats.materializerErrors++;
      recordFailure(stats, {
        eventId: bundle.eventId,
        type: e.event.$type,
        reason: "materializer",
        message: bundle.message,
      });
      if (isDebugEnabled()) {
        recordMaterialization({
          streamDid: streamId,
          idx: e.idx,
          eventType: e.event.$type,
          eventId: bundle.eventId,
          status: "materializer_error",
          errorMessage: bundle.message,
          bundle,
        });
      }
      continue;
    }

    try {
      // Apply bundle statements via the async applyBundle (which handles
      // savepoints, sortIdx, activityItem, unread counters, thread activity).
      await applyBundle(db, bundle, { isBackfill: opts.isBackfill, streamId });
      stats.applied++;

      // Detect URLs in message content and store as link embeds.
      // This runs outside the transaction but is idempotent — enrichment
      // (fetching OpenGraph data) happens asynchronously anyway.
      if (
        e.event.$type === "space.roomy.message.createMessage.v0" &&
        e.event.room
      ) {
        const body = (e.event as Record<string, unknown>).body as
          | { mimeType?: string; data?: { buf: Uint8Array } }
          | undefined;
        if (body?.data?.buf) {
          const mime = body.mimeType ?? "text/markdown";
          const content = decodeContent(mime, Buffer.from(body.data.buf));
          const detected = await detectAndStoreLinks(db, e.event.id, content);
          if (detected.length > 0) stats.detectedLinks.push(...detected);
        }
      }

      if (isDebugEnabled()) {
        recordMaterialization({
          streamDid: streamId,
          idx: e.idx,
          eventType: e.event.$type,
          eventId: e.event.id,
          status: "applied",
          bundle,
        });
      }
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
      if (isDebugEnabled()) {
        recordMaterialization({
          streamDid: streamId,
          idx: e.idx,
          eventType: e.event.$type,
          eventId: e.event.id,
          status: "apply_error",
          errorMessage: message,
        });
      }
    }

    const done = stats.applied + stats.materializerErrors + stats.applyErrors;
    if (done >= nextLogAt && done < total) {
      nextLogAt = done + logInterval;
      const pct = Math.round((done / total) * 100);
      log.info("materialize", `${streamId}: ${done}/${total} events (${pct}%) — ${stats.applied} applied, ${stats.materializerErrors} materializer errors, ${stats.applyErrors} apply errors`);
    }
  }

  // Advance the cursor in a transaction. The cursor update is the only
  // operation that needs atomicity — it must not advance past events that
  // failed to apply.
  steps.push({
    type: "run",
    sql: `update comp_space
           set backfilled_to = ?,
               updated_at = (unixepoch() * 1000)
           where entity = ?
             and (backfilled_to is null or backfilled_to < ?)`,
    params: [latestIdx, streamId, latestIdx],
  });

  if (steps.length > 0) {
    await db.transaction(steps);
  }

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
