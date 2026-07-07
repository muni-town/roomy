/**
 * Apply a batch of decoded events to the database.
 *
 * Events are processed in chunks, each chunk in a single `db.transaction()`
 * call. Per-event savepoints provide error isolation within each chunk.
 * This reduces ~115k transaction round-trips to ~230 (for 500-event chunks).
 *
 * Side-effects (activity_item, link detection) that need JS logic run
 * post-transaction since they're idempotent.
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
import { decodeTime, ulid } from "ulidx";

import { log } from "../log.ts";
const MAX_TRACKED_FAILURES = 100;
const CHUNK_SIZE = 500;

export interface ApplyBatchOpts {
  /** True for backfill events — skips the unread-counter increment. */
  isBackfill: boolean;
}

export interface MaterializationStats {
  applied: number;
  materializerErrors: number;
  applyErrors: number;
  failed: Array<{
    eventId: Ulid;
    type: string;
    reason: "materializer" | "apply";
    message: string;
  }>;
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

  const total = events.length;
  const logInterval = Math.max(500, Math.round(total / 10));
  let nextLogAt = logInterval;

  // Process events in chunks, each chunk in one transaction
  for (let offset = 0; offset < events.length; offset += CHUNK_SIZE) {
    const chunk = events.slice(offset, offset + CHUNK_SIZE);
    const chunkSteps: Array<{ type: "run" | "exec"; sql: string; params?: unknown[] }> = [];

    for (const e of chunk) {
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

      // Per-event savepoint for error isolation within the chunk
      const savepoint = `evt_${e.event.id.replace(/[^a-zA-Z0-9]/g, "")}`;
      chunkSteps.push({ type: "exec", sql: `savepoint ${savepoint}` });

      for (const stmt of bundle.statements) {
        const params = stmt.params;
        if (params === undefined) {
          chunkSteps.push({ type: "run", sql: stmt.sql });
        } else if (Array.isArray(params)) {
          chunkSteps.push({ type: "run", sql: stmt.sql, params: params as unknown[] });
        } else {
          chunkSteps.push({ type: "run", sql: stmt.sql, params: [params] });
        }
      }

      // sort_idx: inline the UPDATE (no SELECT needed)
      if (e.event.$type === "space.roomy.message.createMessage.v0") {
        const overrideExt =
          (e.event as Record<string, unknown>).extensions?.["space.roomy.extension.timestampOverride.v0"] as
            | { timestamp?: string }
            | undefined;
        const timestamp = overrideExt
          ? Number(overrideExt.timestamp)
          : decodeTime(e.event.id);
        const sortIdx = ulid(timestamp);
        chunkSteps.push({
          type: "run",
          sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
          params: [sortIdx, e.event.id],
        });
      }

      // forwardMessages sort_idx copy
      if (
        e.event.$type === "space.roomy.message.forwardMessages.v0" &&
        "messageIds" in e.event &&
        Array.isArray((e.event as Record<string, unknown>).messageIds)
      ) {
        const originalId = (e.event as Record<string, unknown>).messageIds[0] as string | undefined;
        if (originalId) {
          chunkSteps.push({
            type: "run",
            sql: "update entities set sort_idx = (select sort_idx from entities where id = ?) where id = ? and sort_idx is null",
            params: [originalId, e.event.id],
          });
        }
      }

      chunkSteps.push({ type: "exec", sql: `release ${savepoint}` });

      stats.applied++;

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

      const done = stats.applied + stats.materializerErrors + stats.applyErrors;
      if (done >= nextLogAt && done < total) {
        nextLogAt = done + logInterval;
        const pct = Math.round((done / total) * 100);
        log.info("materialize", `${streamId}: ${done}/${total} events (${pct}%) — ${stats.applied} applied, ${stats.materializerErrors} materializer errors, ${stats.applyErrors} apply errors`);
      }
    }

    // Compute the max idx for this chunk — used to advance the cursor after
    // the chunk is processed (whether it succeeded or failed).
    let chunkMaxIdx: StreamIndex = 0 as StreamIndex;
    for (const e of chunk) {
      if (e.idx > chunkMaxIdx) chunkMaxIdx = e.idx;
    }

    // Run this chunk in a single transaction (event SQL only — the cursor
    // is advanced separately below so it also advances past chunks with
    // apply errors, preventing infinite retry loops on every boot).
    if (chunkSteps.length > 0) {
      try {
        await db.transaction(chunkSteps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stats.applyErrors += chunk.length;
        stats.applied -= chunk.length;
        for (const e of chunk) {
          recordFailure(stats, {
            eventId: e.event.id,
            type: e.event.$type,
            reason: "apply",
            message,
          });
        }
      }
    }

    // Advance the materialization cursor for this chunk. This is a SEPARATE
    // transaction from the chunk's event SQL, so it advances even when the
    // chunk had apply errors. Without this, streams with 100% apply errors
    // would never advance the cursor and would be fully replayed on every
    // boot — an infinite retry loop. The materializer output is idempotent
    // (upserts), so if a crash happens between the chunk commit and this
    // cursor update, the chunk is replayed on restart but produces the same
    // result — harmless.
    await db.run(
      `insert into materialization_cursor (stream_id, materialized_to)
       values (?, ?)
       on conflict (stream_id) do update set materialized_to = excluded.materialized_to
       where materialization_cursor.materialized_to < excluded.materialized_to`,
      streamId,
      chunkMaxIdx,
    );

    // Post-transaction side-effects for this chunk: activity_item upsert and
    // link detection. These need JS logic so they can't be inlined as SQL
    // steps. Running them per-chunk keeps them interleaved with progress
    // logging rather than causing a long freeze after the last progress line.
    await applyChunkSideEffects(db, chunk, streamId, opts.isBackfill, stats.detectedLinks);
  }

  // Advance the legacy comp_space.backfilled_to cursor. The authoritative
  // materialization_cursor is now advanced per-chunk (above), so it already
  // reflects progress. This legacy cursor is kept for backwards compatibility
  // and only exists for streams that have a comp_space row.
  await db.transaction([
    {
      type: "run",
      sql: `update comp_space
           set backfilled_to = ?,
               updated_at = (unixepoch() * 1000)
           where entity = ?
             and (backfilled_to is null or backfilled_to < ?)`,
      params: [latestIdx, streamId, latestIdx],
    },
  ]);

  return stats;
}

/**
 * Post-transaction side-effects for a chunk: activity_item upsert and link
 * detection. These need JS logic (JSON array manipulation, URL extraction)
 * so they can't be inlined as SQL steps. Running them per-chunk keeps them
 * interleaved with progress logging rather than causing a long freeze after
 * the last progress line.
 */
async function applyChunkSideEffects(
  db: DbLike,
  chunk: DecodedStreamEvent[],
  streamId: StreamDid,
  isBackfill: boolean,
  detectedLinks: string[],
): Promise<void> {
  for (const e of chunk) {
    if (e.event.$type === "space.roomy.message.createMessage.v0" && (e.event as Record<string, unknown>).room) {
      await applyBundle(db, {
        status: "success",
        event: e.event,
        eventIdx: e.idx,
        user: e.user,
        statements: [],
        dependsOn: [],
      }, { isBackfill, streamId });

      const body = (e.event as Record<string, unknown>).body as
        | { mimeType?: string; data?: { buf: Uint8Array } }
        | undefined;
      if (body?.data?.buf) {
        const mime = body.mimeType ?? "text/markdown";
        const content = decodeContent(mime, Buffer.from(body.data.buf));
        const detected = await detectAndStoreLinks(db, e.event.id, content);
        if (detected.length > 0) detectedLinks.push(...detected);
      }
    }
  }
}


function recordFailure(
  stats: MaterializationStats,
  failure: MaterializationStats["failed"][number],
): void {
  if (stats.failed.length < MAX_TRACKED_FAILURES) {
    stats.failed.push(failure);
  }
}
