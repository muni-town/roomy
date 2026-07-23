/**
 * Re-materialize streams from the local events DB, skipping streams that are
 * already fully materialized.
 *
 * Uses the `materialization_cursor` table to determine which streams need
 * replay: for each stream with events, compares the cursor's `materialized_to`
 * against the latest event idx in `events.stream_events`. Streams that are
 * already caught up are skipped; the rest are replayed from `cursor + 1`.
 *
 * After a schema-version wipe the cursor table is empty (all cursors default
 * to -1), so every stream is fully replayed. After a clean restart the
 * cursors are current and nothing is replayed. After a crash mid-sendEvents
 * only the un-materialized gap is replayed.
 */

import { decode } from "@atcute/cbor";
import { type DecodedStreamEvent, type Event, type StreamDid, type StreamIndex, type UserDid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { applyBatch } from "../materialization/applyBatch.ts";
import {
  ensureProfilesForBatch,
  ensureProfilesRoomyFirst,
  type GetProfilesFn,
} from "../materialization/profiles.ts";
import type { HappyViewConfig } from "../happyview.ts";
import { log } from "../log.ts";

interface RawEvent {
  idx: number;
  user: string;
  payload: Uint8Array;
}

/**
 * Re-materialize streams that have un-materialized events in the local events DB.
 *
 * Streams are processed sequentially (one at a time) to keep memory bounded.
 * Within a stream, the un-materialized events are batched — read in one query
 * and materialized in one `applyBatch` call, which is the fastest path for a
 * replay. Streams whose cursor is already at the latest event idx are skipped
 * entirely (no event reads, no materialization).
 *
 * Profiles for any user DIDs referenced by profile-relevant events
 * (joinSpace / createMessage / addAdmin) are hydrated from the bsky appview
 * before the batch is applied — the live `sendEvents` path does the same, and
 * without it backfilled messages render with blank author profiles.
 *
 * Logs progress at info level. Errors for individual streams are logged but
 * do not abort the overall process — a failed stream will be re-materialized
 * on demand when first accessed.
 */
export async function reMaterializeFromLocalEvents(
  db: DbLike,
  getProfiles: GetProfilesFn | undefined = undefined,
  happyView: HappyViewConfig | null = null,
): Promise<void> {
  const streams = await db
    .query("SELECT DISTINCT stream_id FROM events.stream_events ORDER BY stream_id")
    .all<{ stream_id: string }>();

  if (streams.length === 0) {
    log.info("startup", "no streams to re-materialize from local events DB");
    return;
  }

  // Read the materialization cursor for all streams in one query. Streams
  // without a cursor row (e.g. after a schema-version wipe, or first boot)
  // default to -1, meaning "nothing materialized yet — replay everything".
  const cursors = new Map<string, number>();
  const cursorRows = await db
    .query("SELECT stream_id, materialized_to FROM materialization_cursor")
    .all<{ stream_id: string; materialized_to: number }>();
  for (const row of cursorRows) {
    cursors.set(row.stream_id, row.materialized_to);
  }

  // Partition streams: those already fully materialized (cursor >= latest
  // event idx in the events DB) are skipped; the rest get replayed from
  // cursor + 1.
  let skipped = 0;
  const toReplay: Array<{ streamId: string; fromIdx: number }> = [];

  for (const { stream_id } of streams) {
    const materializedTo = cursors.get(stream_id) ?? -1;

    // Check the latest event idx for this stream in the events DB.
    const latestRow = await db
      .query(
        "SELECT coalesce(max(idx), -1) AS latest FROM events.stream_events WHERE stream_id = ?",
      )
      .get<{ latest: number }>(stream_id);
    const latest = latestRow?.latest ?? -1;

    if (materializedTo >= latest) {
      skipped++;
      continue;
    }

    toReplay.push({ streamId: stream_id, fromIdx: materializedTo + 1 });
  }

  if (toReplay.length === 0) {
    log.info(
      "startup",
      `re-materialization: all ${skipped} streams already up to date, nothing to replay`,
    );
    return;
  }

  log.info(
    "startup",
    `re-materializing ${toReplay.length} streams from local events DB (${skipped} already up to date)`,
  );

  let succeeded = 0;
  let failed = 0;

  for (const { streamId: streamDid, fromIdx } of toReplay) {
    try {
      const rawEvents = await db
        .query(
          "SELECT idx, user, payload FROM events.stream_events WHERE stream_id = ? AND idx >= ? ORDER BY idx",
        )
        .all<RawEvent>(streamDid, fromIdx);

      if (rawEvents.length === 0) {
        succeeded++;
        continue;
      }

      const decodedEvents: DecodedStreamEvent[] = rawEvents.map(
        (e): DecodedStreamEvent => ({
          idx: e.idx as StreamIndex,
          event: decode(e.payload) as Event,
          user: e.user as UserDid,
        }),
      );

      // Hydrate profiles for any new-user events in this batch before
      // materializing, mirroring the live sendEvents path. Without this,
      // backfilled messages render with blank author profiles. When a
      // custom fetcher is provided (tests), use the injectable path.
      // Otherwise use the HappyView-first fetcher (HappyView → Bluesky
      // fallback, or Bluesky-only when HappyView is not configured).
      if (getProfiles) {
        await ensureProfilesForBatch(db, decodedEvents, getProfiles);
      } else {
        await ensureProfilesRoomyFirst(db, decodedEvents, happyView);
      }

      const stats = await applyBatch(db, streamDid as StreamDid, decodedEvents, {
        isBackfill: true,
      });

      succeeded++;
      const total = toReplay.length;
      const pct = Math.round((succeeded / total) * 100);
      const progress = `[${succeeded}/${total} ${pct}%]`;

      if (stats.materializerErrors > 0 || stats.applyErrors > 0) {
        log.warn(
          "startup",
          `${progress} re-materialize ${streamDid}: ${stats.applied} applied, ${stats.materializerErrors} materializer errors, ${stats.applyErrors} apply errors`,
        );
      } else {
        log.info(
          "startup",
          `${progress} re-materialize ${streamDid}: ${stats.applied} applied, 0 errors`,
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