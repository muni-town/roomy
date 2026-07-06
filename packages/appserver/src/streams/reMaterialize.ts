/**
 * Re-materialize all streams from the local events DB.
 *
 * Reads every stream's events from `events.stream_events` and feeds them
 * through `applyBatch` to rebuild the materialized views. Called on boot
 * after a schema version wipe, or after running the Leaf migration script.
 *
 * This replaces the old Leaf-based startup backfill — instead of subscribing
 * to Leaf for each stream, we replay the local event log.
 */

import { decode } from "@atcute/cbor";
import { type DecodedStreamEvent, type Event, type StreamDid, type StreamIndex, type UserDid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { applyBatch } from "../materialization/applyBatch.ts";
import { log } from "../log.ts";

interface RawEvent {
  idx: number;
  user: string;
  payload: Uint8Array;
}

/**
 * Re-materialize every stream that has events in the local events DB.
 *
 * Streams are processed sequentially (one at a time) to keep memory bounded.
 * Within a stream, events are batched — the entire stream's events are read
 * and materialized in one `applyBatch` call, which is the fastest path for
 * a full re-materialization.
 *
 * Logs progress at info level. Errors for individual streams are logged but
 * do not abort the overall process — a failed stream will be re-materialized
 * on demand when first accessed.
 */
export async function reMaterializeFromLocalEvents(db: DbLike): Promise<void> {
  const streams = await db
    .query("SELECT DISTINCT stream_id FROM events.stream_events ORDER BY stream_id")
    .all<{ stream_id: string }>();

  if (streams.length === 0) {
    log.info("startup", "no streams to re-materialize from local events DB");
    return;
  }

  log.info("startup", `re-materializing ${streams.length} streams from local events DB`);

  let succeeded = 0;
  let failed = 0;

  for (const { stream_id } of streams) {
    const streamDid = stream_id as StreamDid;

    try {
      const rawEvents = await db
        .query(
          "SELECT idx, user, payload FROM events.stream_events WHERE stream_id = ? ORDER BY idx",
        )
        .all<RawEvent>(streamDid);

      if (rawEvents.length === 0) continue;

      const decodedEvents: DecodedStreamEvent[] = rawEvents.map(
        (e): DecodedStreamEvent => ({
          idx: e.idx as StreamIndex,
          event: decode(e.payload) as Event,
          user: e.user as UserDid,
        }),
      );

      const stats = await applyBatch(db, streamDid, decodedEvents, {
        isBackfill: true,
      });

      succeeded++;

      if (stats.materializerErrors > 0 || stats.applyErrors > 0) {
        log.warn(
          "startup",
          `re-materialize ${streamDid}: ${stats.applied} applied, ${stats.materializerErrors} materializer errors, ${stats.applyErrors} apply errors`,
        );
      }
    } catch (err) {
      failed++;
      log.error(
        "startup",
        `re-materialize failed for ${streamDid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log.info(
    "startup",
    `re-materialization complete: ${succeeded} succeeded, ${failed} failed`,
  );
}
