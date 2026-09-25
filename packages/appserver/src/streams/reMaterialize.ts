/**
 * Re-materialize streams from the local events DB, skipping streams that are
 * already fully materialized.
 *
 * Uses the `materialization_cursor` table to determine which streams need
 * replay: for each stream with events, compares the cursor's `materialized_to`
 * against the latest event idx in `stream_events`. Streams that are
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
import { runPendingGlobalMigrations } from "../db/globalMigrations.ts";
import { refreshSpaceStats } from "../queries/spaceStats.ts";

interface RawEvent {
  idx: number;
  user: string;
  payload: Uint8Array;
}

/** Default number of streams re-materialized concurrently (matches the pool default). */
export const DEFAULT_REMATERIALIZE_CONCURRENCY = 4;

/**
 * Re-materialize streams that have un-materialized events in the local events DB.
 *
 * Streams are processed with bounded concurrency (up to `concurrency` at
 * once) so different spaces' replay lands on different pool workers in
 * parallel. The cap keeps memory bounded — we never load every stream's
 * event batch into memory at once. Within a stream, the un-materialized
 * events are batched — read in one query and materialized in one
 * `applyBatch` call, which is the fastest path for a replay. Streams whose
 * cursor is already at the latest event idx are skipped entirely (no event
 * reads, no materialization).
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
  concurrency: number = DEFAULT_REMATERIALIZE_CONCURRENCY,
): Promise<void> {
  const streams = await db
    .query("SELECT DISTINCT stream_id FROM stream_events ORDER BY stream_id")
    .all<{ stream_id: string }>();

  const streamDids = streams.map(({ stream_id }) => stream_id as StreamDid);
  const finishGlobalMigrations = async (): Promise<void> => {
    try {
      await runPendingGlobalMigrations(db, streamDids);
    } catch (err) {
      // A failed post-migration remains pending and retries next boot. It must
      // not prevent normal per-space catch-up from completing.
      log.error(
        "startup",
        `global post-migration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (streams.length === 0) {
    await finishGlobalMigrations();
    log.info("startup", "no streams to re-materialize from local events DB");
    return;
  }

  // Partition streams into blue-green rebuilds and incremental catch-ups.
  //
  // A stream whose canonical per-space DB is on a STALE schema is rebuilt from
  // the event log into a temp `.sqlite.new` DB (fresh, current schema) and
  // atomically swapped over the canonical file. Reads keep serving the old DB
  // until the swap, so a schema bump never makes a space appear empty. On any
  // failure the temp DB is aborted and the old DB keeps serving.
  //
  // A stream whose canonical DB is on the CURRENT schema uses the existing
  // incremental catch-up path unchanged (skip if caught up, else replay the
  // un-materialized gap from cursor + 1).
  let skipped = 0;
  const toReplay: Array<{
    streamId: string;
    fromIdx: number;
    /** Rebuild the whole stream into a temp new-schema DB and swap it in. */
    rebuild: boolean;
  }> = [];

  for (const { stream_id } of streams) {
    // Blue-green decision point: is the canonical per-space DB on the current
    // schema? When `checkSpaceSchema` is absent (sync adapters in tests that
    // don't exercise the rebuild), default to current so behavior is unchanged.
    const { current } =
      (await db.checkSpaceSchema?.(stream_id)) ?? { current: true };

    if (!current) {
      // Stale schema ⇒ full rebuild. Replay the entire stream (idx from 0)
      // into the temp rebuild DB, then commit the swap. `applyBatch` writes
      // entity_space + materialization_cursor into the new DB, so no backfill
      // of the old DB is needed.
      toReplay.push({ streamId: stream_id, fromIdx: 0, rebuild: true });
      continue;
    }

    // Backfill the global `entity_space` index from this space's
    // per-space DB. Existing per-space DBs materialized before the index
    // existed have no entries, so `openSpaceDbForEntity` would 404 on every
    // room/message. This runs for every current-schema stream (caught up or
    // not) and is idempotent. Worker-internal, so it's one round-trip per
    // space. (Rebuild streams skip this — applyBatch populates the index.)
    try {
      await db.backfillEntitySpace?.(stream_id);
    } catch (err) {
      log.warn(
        "startup",
        `entity_space backfill failed for ${stream_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Publish this space's `space_stats` aggregate row. Member count only
    // exists in the space's own DB, so the admin dashboard's member-count
    // ordering needs it precomputed; a per-request aggregate would fan out over
    // every space. This sweep runs for every stream on every boot (caught up or
    // not), so an existing dataset self-heals on the next deploy and no separate
    // data migration is needed. Idempotent.
    try {
      await refreshSpaceStats(db, stream_id as StreamDid);
    } catch (err) {
      log.warn(
        "startup",
        `space_stats refresh failed for ${stream_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // The materialization_cursor lives in the per-space DB (each
    // space DB is self-describing about its own re-materialization state),
    // not the event-log DB. Read it from the per-space handle. Streams
    // without a cursor row (e.g. after a schema-version wipe, or first boot)
    // default to -1, meaning "nothing materialized yet — replay everything".
    const cursorRow = await db
      .forSpace!(stream_id as StreamDid)
      .query("SELECT materialized_to FROM materialization_cursor WHERE stream_id = ?")
      .get<{ materialized_to: number }>(stream_id);
    const materializedTo = cursorRow?.materialized_to ?? -1;

    // Check the latest event idx for this stream in the events DB.
    const latestRow = await db
      .query(
        "SELECT coalesce(max(idx), -1) AS latest FROM stream_events WHERE stream_id = ?",
      )
      .get<{ latest: number }>(stream_id);
    const latest = latestRow?.latest ?? -1;

    if (materializedTo >= latest) {
      skipped++;
      continue;
    }

    toReplay.push({
      streamId: stream_id,
      fromIdx: materializedTo + 1,
      rebuild: false,
    });
  }

  if (toReplay.length === 0) {
    await finishGlobalMigrations();
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
  const total = toReplay.length;
  const cap = Math.max(1, Math.min(Math.floor(concurrency), total));

  // Bounded-concurrency worker pool: up to `cap` streams are replayed at
  // once, each pulling the next pending stream as it finishes. Different
  // streams hash to different pool workers, so their applyBatch
  // runs in parallel. The cap keeps memory bounded (never all streams in
  // flight at once) while still using the pool.
  const nextIndex = { i: 0 };

  const replayWorker = async (): Promise<void> => {
    while (true) {
      const idx = nextIndex.i++;
      if (idx >= total) return;
      const { streamId: streamDid, fromIdx, rebuild } = toReplay[idx]!;
      try {
        // Blue-green rebuild: begin explicitly so the temp `.sqlite.new` DB is
        // created and the space is flagged rebuilding BEFORE replay starts
        // (and before any slow profile hydration holds the window open) —
        // otherwise `isSpaceRebuilding` is still false while we replay and the
        // write gate wouldn't reject during the window. Idempotent, so it
        // is safe alongside the lazy `forSpaceRebuild` auto-begin.
        if (rebuild) {
          await db.spaceRebuildBegin!(streamDid as StreamDid);
        }
        // Blue-green rebuild targets the temp new-schema DB; the canonical
        // (read-serving) DB is untouched until commit. Incremental catch-up
        // targets the canonical DB as before.
        const handle = rebuild
          ? db.forSpaceRebuild!(streamDid as StreamDid)
          : db.forSpace!(streamDid as StreamDid);

        const rawEvents = await db
          .query(
            "SELECT idx, user, payload FROM stream_events WHERE stream_id = ? AND idx >= ? ORDER BY idx",
          )
          .all<RawEvent>(streamDid, fromIdx);

        if (rawEvents.length > 0) {
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

          const globalDb = db.global?.();
          const stats = await applyBatch(handle, streamDid as StreamDid, decodedEvents, {
            isBackfill: true,
          }, globalDb);

          if (stats.materializerErrors > 0 || stats.applyErrors > 0) {
            log.warn("[re-materialize] stream-done", {
              streamId: streamDid,
              applied: stats.applied,
              materializerErrors: stats.materializerErrors,
              applyErrors: stats.applyErrors,
              rebuild,
            });
          } else {
            log.info("[re-materialize] stream-done", {
              streamId: streamDid,
              applied: stats.applied,
              materializerErrors: 0,
              applyErrors: 0,
              rebuild,
            });
          }
        }

        if (rebuild) {
          // Atomic swap: the temp rebuild DB replaces the canonical file and
          // routing flips. The cursor was advanced by applyBatch.
          await db.spaceRebuildCommit!(streamDid as StreamDid);
        }
        succeeded++;
      } catch (err) {
        if (rebuild) {
          // Never swap in a broken/partial DB — abort and keep serving the
          // old DB. The next boot re-runs the rebuild for this stream.
          try {
            await db.spaceRebuildAbort!(streamDid as StreamDid);
          } catch {
            /* best-effort */
          }
        }
        failed++;
        log.error(
          "startup",
          `re-materialize failed for ${streamDid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if ((succeeded + failed) % 25 === 0 || succeeded + failed === total) {
        const pct = Math.round(((succeeded + failed) / total) * 100);
        log.info("[re-materialize] progress", {
          done: succeeded + failed,
          total,
          pct,
          succeeded,
          failed,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: cap }, () => replayWorker()));

  await finishGlobalMigrations();

  log.info("[re-materialize] complete", { succeeded, failed });
}