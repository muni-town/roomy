/**
 * Apply a batch of decoded events to the per-space database.
 *
 * Events are processed in chunks, each chunk in a single `db.transaction()`
 * call. Per-event savepoints provide error isolation within each chunk.
 * This reduces ~115k transaction round-trips to ~230 (for 500-event chunks).
 *
 * Side-effects (activity_item, link detection) that need JS logic run
 * post-transaction since they're idempotent.
 *
 * Per-space split (Phase 3): `db` is the per-space DB — the source of truth
 * for space data. There is no monolithic DB. `globalDb` (optional) receives
 * the `joinedSpace`/`leftSpace` membership edges and the `entity_space`
 * entity→space index. The materialization cursor advances on the per-space
 * DB so each space DB is self-describing about its own re-materialisation
 * progress.
 */

import type { DbLike } from "../db/types.ts";
import type {
  DecodedStreamEvent,
  StreamDid,
  StreamIndex,
  Ulid,
  UserDid,
} from "@roomy-space/sdk";

import { materialize } from "./materializer.ts";
import { applyBundle, getSavepointMutex } from "./applyBundle.ts";
import { canonicalMessageTimestamp } from "./sortIdx.ts";
import { isGlobalDbStatement } from "./statementRouting.ts";
import type { StatementBundleSuccess } from "./types.ts";
import {
  isDebugEnabled,
  recordMaterialization,
} from "../debug/eventStore.ts";
import {
  detectAndStoreLinks,
  detectAndStoreLinksFromUrls,
} from "../embed/enricher.ts";
import { openReadStateDb } from "../db/db.ts";
import {
  classifyMembershipEvent,
  setUserSpaceMembership,
  type MembershipIntent,
} from "../queries/userSpaceMembership.ts";
import { decodeContent, decodeRichTextBody } from "../db/content.ts";
import { enqueueIndexMessage, enqueueDeleteMessage } from "../search/indexer.ts";
import { RICHTEXT_MIME, extractFacetUrls } from "@roomy-space/sdk";
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

interface ChunkStep {
  type: "run" | "exec";
  sql: string;
  params?: unknown[];
  /** Derived-DB routing: "space" (default), "global", or "none" (no derived write). */
  derived: "space" | "global" | "none";
}

export async function applyBatch(
  db: DbLike,
  streamId: StreamDid,
  events: DecodedStreamEvent[],
  opts: ApplyBatchOpts,
  globalDb?: DbLike,
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
    const chunkSteps: ChunkStep[] = [];
    // Live join/leave events → durable membership intent, keyed by the
    // mangled savepoint id so the execution loop can write it after the
    // event's per-space/global steps succeed.
    const membershipIntents = new Map<string, MembershipIntent>();

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
      // Capture durable membership intent for live join/leave events (written
      // to the read-state DB after this event's steps succeed). Backfill is
      // skipped — the boot recovery migration already reduced the full
      // historical log by ULID, and replay events aren't guaranteed to arrive
      // in ULID order across streams.
      if (!opts.isBackfill) {
        const intent = classifyMembershipEvent(e.event, streamId, e.user);
        if (intent) membershipIntents.set(savepoint, intent);
      }
      chunkSteps.push({ type: "exec", sql: `savepoint ${savepoint}`, derived: "none" });
      for (const stmt of bundle.statements) {
        const params = stmt.params;
        chunkSteps.push({
          type: "run",
          sql: stmt.sql,
          params:
            params === undefined
              ? undefined
              : Array.isArray(params)
                ? (params as unknown[])
                : [params],
          derived: isGlobalDbStatement(stmt.sql) ? "global" : "space",
        });
        // Phase 3: maintain the global entity→space index. Every `insert
        // into entities` statement carries (id, stream_id) as its first two
        // params; record the mapping so `openSpaceDbForEntity` can resolve
        // which per-space DB a room/message id lives in. Skip entities with
        // an empty stream_id (e.g. link entities) — they are never resolved
        // via openSpaceDbForEntity.
        if (stmt.sql.trim().startsWith("insert into entities")) {
          const p = Array.isArray(params) ? params : [params];
          const id = p[0];
          const sid = p[1];
          if (typeof id === "string" && typeof sid === "string" && sid !== "") {
            chunkSteps.push({
              type: "run",
              sql: "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
              params: [id, sid],
              derived: "global",
            });
          }
        }
      }

      // sort_idx: inline the UPDATE (no SELECT needed)
      if (e.event.$type === "space.roomy.message.createMessage.v0") {
        const sortIdx = ulid(canonicalMessageTimestamp(e.event)) as Ulid;
        chunkSteps.push({
          type: "run",
          sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
          params: [sortIdx, e.event.id],
          derived: "space",
        });
      }

      // forwardMessages sort_idx: the forward-reference entity sorts by the
      // forward event's OWN time (its ULID), so a forward appears at the top
      // of the destination room's timeline — matching the modern
      // forward-as-embed representation (createMessage + forward attachment).
      // Previously the original's sort_idx was copied, which buried a forward
      // of an old message deep in history, outside the first getMessages page
      // (the client's room query returns the newest `limit` rows), so the
      // forward flashed in via the WS diff and vanished on the next refetch.
      if (e.event.$type === "space.roomy.message.forwardMessages.v0") {
        const sortIdx = ulid(decodeTime(e.event.id)) as Ulid;
        chunkSteps.push({
          type: "run",
          sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
          params: [sortIdx, e.event.id],
          derived: "space",
        });
      }

      chunkSteps.push({ type: "exec", sql: `release ${savepoint}`, derived: "none" });

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
        // Structured progress telemetry (Loki): one line per ~10% of the
        // batch. Query in Grafana with
        // `{scope="materialize"} | json | unwrap applied`.
        log.info("[materialize] progress", {
          streamId,
          done,
          total,
          pct,
          applied: stats.applied,
          materializerErrors: stats.materializerErrors,
          applyErrors: stats.applyErrors,
          isBackfill: opts.isBackfill,
        });
      }
    }

    // Compute the max idx for this chunk — used to advance the cursor after
    // the chunk is processed (whether it succeeded or failed).
    let chunkMaxIdx: StreamIndex = 0 as StreamIndex;
    for (const e of chunk) {
      if (e.idx > chunkMaxIdx) chunkMaxIdx = e.idx;
    }

    // Run this chunk's event SQL individually, with per-event savepoints
    // providing error isolation. Each event's SAVEPOINT/RELEASE pair wraps
    // its statements; if one event fails, only that event's changes are
    // rolled back. The cursor is advanced separately below so it also
    // advances past chunks with apply errors, preventing infinite retry
    // loops on every boot.
    //
    // Run this chunk's event SQL batched into per-event transactions
    // (Phase 4b). Each event's statements go to the per-space DB in a single
    // `transaction` message — one worker round-trip instead of one per
    // statement. The worker runs it as an atomic SQLite transaction, giving
    // the same per-event error isolation the old SAVEPOINT/RELEASE did, but
    // collapsing ~N round-trips into one. Global statements (membership edges
    // + entity_space index) go to the global DB in a second single
    // `transaction` message. This directly attacks the dominant materialization
    // cost — main-thread postMessage round-trip overhead was ~28% self-time in
    // the CPU profile.
    //
    // Concurrency: each event is a single atomic transaction message, so the
    // worker serializes them — no SAVEPOINT/RELEASE to interleave. Different
    // spaces no longer wait on one process-wide `savepointMutex`. But same-space
    // sections still take a per-space lock shared with `applyBundle`: its
    // SAVEPOINT section must never overlap our `transaction` (a `BEGIN` nested
    // in an open SAVEPOINT fails). Per-space lock keeps cross-space parallelism.
    await getSavepointMutex(streamId).run(async () => {
      for (let i = 0; i < chunkSteps.length; i++) {
        const step = chunkSteps[i]!;
        if (step.type === "exec" && step.sql.startsWith("savepoint evt_")) {
          // Collect all steps for this event (savepoint → statements → release)
          const eventSteps: ChunkStep[] = [];
          for (let j = i; j < chunkSteps.length; j++) {
            const s = chunkSteps[j]!;
            eventSteps.push(s);
            if (s.type === "exec" && s.sql.startsWith("release evt_")) {
              i = j;
              break;
            }
          }
          const spaceSteps = eventSteps
            .filter((s) => s.type === "run" && s.derived === "space")
            .map((s) => ({ type: "run" as const, sql: s.sql, params: s.params }));
          const globalSteps = eventSteps
            .filter((s) => s.type === "run" && s.derived === "global")
            .map((s) => ({ type: "run" as const, sql: s.sql, params: s.params }));

          // ── Per-space DB (source of truth) ──────────────────────────────
          // One atomic transaction per event; a failure rolls back just this
          // event (equivalent to the old savepoint isolation).
          let spaceFailed = false;
          try {
            if (spaceSteps.length > 0) {
              await db.transaction(spaceSteps);
            }
          } catch (err) {
            spaceFailed = true;
            const message = err instanceof Error ? err.message : String(err);
            stats.applyErrors++;
            stats.applied--;
            recordFailure(stats, {
              eventId: "" as unknown as Ulid,
              type: "unknown",
              reason: "apply",
              message,
            });
          }
          if (spaceFailed) continue;

          // ── Global DB ──────────────────────────────────────────────────
          // Membership edges + entity_space index. A failure here never
          // rolls back the per-space DB — the event stays applied there
          // and the global DB is repaired by re-materialisation.
          if (globalDb && globalSteps.length > 0) {
            try {
              await globalDb.transaction(globalSteps);
            } catch (globalErr) {
              const message =
                globalErr instanceof Error ? globalErr.message : String(globalErr);
              stats.applyErrors++;
              recordFailure(stats, {
                eventId: "" as unknown as Ulid,
                type: "global-db",
                reason: "apply",
                message: `[globalDb] ${message}`,
              });
              log.error(
                `[materialize] globalDb write failed for ${streamId} (per-space intact): ${message}`,
              );
            }
          }

          // ── Read-state: durable membership intent ──────────────────────
          // Live join/leave events update `user_space_membership` (the
          // read-state source of truth) so intent stays durable regardless of
          // which writer produced the event — not just the XRPC fast-path
          // handlers. Backfill/replay is skipped: the boot recovery migration
          // already reduced the full historical log by ULID, and replay events
          // aren't guaranteed to arrive in ULID order across streams, so
          // writing them could overwrite the correct recovered state with an
          // older event. A read-state failure never rolls back the per-space
          // application (the next event / recovery retries it).
          const savepointName = step.sql.replace(/^savepoint /, "");
          const intent = membershipIntents.get(savepointName);
          if (intent) {
            try {
              await setUserSpaceMembership(
                openReadStateDb(),
                intent.userDid as UserDid,
                intent.spaceDid as StreamDid,
                intent.state,
                intent.source,
                intent.eventId,
              );
            } catch (readStateErr) {
              const message =
                readStateErr instanceof Error
                  ? readStateErr.message
                  : String(readStateErr);
              stats.applyErrors++;
              recordFailure(stats, {
                eventId: intent.eventId as Ulid,
                type: "read-state",
                reason: "apply",
                message: `[readState] ${message}`,
              });
            }
          }
        }
      }
    });

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
    await applyChunkSideEffects(db, chunk, streamId, opts.isBackfill, stats.detectedLinks, globalDb);
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

  // Completion telemetry (Loki): one line per batch. The final applied count
  // is the cross-restart progress signal for a stream (the per-space
  // materialization_cursor persists), so a Grafana panel can track how far a
  // space has materialized over time. Query with
  // `{scope="materialize"} | json | unwrap applied`.
  log.info("[materialize] done", {
    streamId,
    total,
    applied: stats.applied,
    materializerErrors: stats.materializerErrors,
    applyErrors: stats.applyErrors,
    isBackfill: opts.isBackfill,
  });

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
  globalDb?: DbLike,
): Promise<void> {
  for (const e of chunk) {
    if (e.event.$type === "space.roomy.message.createMessage.v0" && (e.event as Record<string, unknown>).room) {
      const bundle: StatementBundleSuccess = {
        status: "success",
        event: e.event,
        eventIdx: e.idx,
        user: e.user,
        statements: [],
        dependsOn: [],
      };
      await applyBundle(db, bundle, { isBackfill, streamId }, globalDb, openReadStateDb());

      // Search indexing (Phase 2): enqueue the message for the out-of-band
      // Qdrant indexer — the worker re-reads the materialised rows, so no
      // synchronous search work happens here.
      enqueueIndexMessage(streamId, e.event.id);

      const body = (e.event as Record<string, unknown>).body as
        | { mimeType?: string; data?: { buf: Uint8Array } }
        | undefined;
      if (body?.data?.buf) {
        const mime = body.mimeType ?? "text/markdown";
        const buf = Buffer.from(body.data.buf);
        let detected: string[];
        if (mime === RICHTEXT_MIME) {
          // New format: URLs come from `#link` facet URIs, not regex scanning.
          const blocks = decodeRichTextBody(mime, buf);
          detected = await detectAndStoreLinksFromUrls(
            db,
            e.event.id,
            blocks ? extractFacetUrls(blocks) : [],
          );
        } else {
          // Legacy text/markdown bodies keep the regex extraction path.
          const content = decodeContent(mime, buf);
          detected = await detectAndStoreLinks(db, e.event.id, content);
        }
        if (detected.length > 0) detectedLinks.push(...detected);
        if (globalDb && detected.length > 0) {
          // Record the link entities in the global entity→space index so
          // they resolve to this space (they carry an empty stream_id in
          // the per-space DB).
          for (const url of detected) {
            await globalDb.run(
              `insert or ignore into entity_space (entity_id, space_did) values (?, ?)`,
              [url, streamId],
            );
          }
          // Dual-write the global pending-links index so the centralized
          // embed sweeper can find this work without iterating every
          // per-space DB. `insert or ignore` keeps the row idempotent across
          // re-materialisation.
          for (const url of detected) {
            await globalDb.run(
              `insert or ignore into pending_links (space_did, message_id, url, created_at)
               values (?, ?, ?, ?)`,
              [streamId, e.event.id, url, Date.now()],
            );
          }
        }
      }
    } else if (e.event.$type === "space.roomy.message.editMessage.v0") {
      // Re-index the edited message: the chunk's statements updated
      // comp_content; the search worker re-reads the updated plaintext.
      const messageId = (e.event as Record<string, unknown>).messageId as string | undefined;
      if (messageId) {
        enqueueIndexMessage(streamId, messageId);
      }
    } else if (e.event.$type === "space.roomy.message.deleteMessage.v0") {
      // Drop the deleted message from the search index.
      const messageId = (e.event as Record<string, unknown>).messageId as string | undefined;
      if (messageId) {
        enqueueDeleteMessage(messageId);
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
