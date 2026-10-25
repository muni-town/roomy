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
 * Per-space split: `db` is the per-space DB — the source of truth
 * for space data. `globalDb` (optional) receives
 * the `joinedSpace`/`leftSpace` membership edges and the `entity_space`
 * entity→space index. The materialization cursor advances on the per-space
 * DB so each space DB is self-describing about its own re-materialisation
 * progress.
 */

import type { DbLike } from "../db/types.ts";
import type {
  SqlStatement,
  StreamDid,
  StreamIndex,
  Ulid,
  UserDid,
} from "@roomy-space/sdk";

import { materialize } from "./materializer.ts";
import { applyBundle, getSavepointMutex } from "./applyBundle.ts";
import { messageSortIdxKey } from "./sortIdx.ts";
import { decidedAtFor } from "./records/recordChange.ts";
import { applyDeleteSideEffects, collectPendingDeletes } from "./deleteMessage.ts";
import { isGlobalDbStatement } from "./statementRouting.ts";
import type { LoggedEvent, StatementBundleSuccess } from "./types.ts";
import {
  applyRecordSideEffects,
  planBatch,
  recordEntryEffects,
} from "./records/recordPath.ts";
import type { DerivedStep } from "./records/effects.ts";
import { applyDerivedStep } from "./derivedSteps.ts";
import {
  isDebugEnabled,
  recordMaterialization,
} from "../debug/eventStore.ts";
import {
  detectAndStoreLinks,
  detectAndStoreLinksFromUrls,
} from "../embed/enricher.ts";
import { linkAttachmentUrls } from "../queries/links.ts";
import { openReadStateDb } from "../db/db.ts";
import { recordSpaceStats, selectMemberCount } from "../queries/spaceStats.ts";
import { maintainRoomAccess } from "../queries/roomAccessProjection.ts";
import { maintainRoomActivity } from "../queries/roomActivityProjection.ts";
import { refreshActivityMetaStatement } from "./records/roomRules.ts";
import {
  classifyMembershipEvent,
  setUserSpaceMembership,
  type MembershipIntent,
} from "../queries/userSpaceMembership.ts";
import { decodeContent, decodeRichTextBody } from "../db/content.ts";
import { enqueueIndexMessage, enqueueDeleteMessage } from "../search/indexer.ts";
import { RICHTEXT_MIME, extractFacetUrls } from "@roomy-space/sdk";


import { log } from "../log.ts";
const MAX_TRACKED_FAILURES = 100;
const CHUNK_SIZE = 500;

export interface ApplyBatchOpts {
  /** True for backfill events — skips the unread-counter increment. */
  isBackfill: boolean;
}

/**
 * Materialised events that can change a space's member/admin edge set, and so
 * invalidate the global `space_stats.member_count` aggregate the admin
 * dashboard sorts on.
 *
 * `space.roomy.query.spaceMeta.v0` is the synthetic event the SDK emits when a
 * space is first connected: it seeds the member edges for the space's admins
 * (synthetic.ts), which is how spaces materialised from a live sync — rather
 * than from joinSpace events — get their member rows.
 */
const MEMBERSHIP_EVENT_TYPES: ReadonlySet<string> = new Set([
  "space.roomy.space.joinSpace.v0",
  "space.roomy.space.leaveSpace.v0",
  "space.roomy.space.addAdmin.v0",
  "space.roomy.space.removeAdmin.v0",
  "space.roomy.query.spaceMeta.v0",
]);

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
  events: LoggedEvent[],
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
    // The derived steps each entry's changes carry, applied after the chunk's
    // SQL (see `records/effects.ts`).
    const derivedSteps: DerivedStep[][] = chunk.map(() => []);

    // Route the chunk: an entry whose every emitted kind is converted applies
    // through the record rules, and every other entry keeps its event
    // materialiser. The plans read the rooms the record rules cannot: see
    // `records/messagePath.ts`.
    const plans = await planBatch(db, chunk, streamId);

    for (let i = 0; i < chunk.length; i++) {
      const e = chunk[i]!;
      const routed = plans[i] ?? null;
      const effects = routed
        ? recordEntryEffects(routed, { streamId, isBackfill: opts.isBackfill })
        : [];
      derivedSteps[i] = effects.filter(
        (effect): effect is DerivedStep => effect.effect !== "sql",
      );

      // The instant the log assigns this entry: what a rule or a materialiser
      // stamps the rows it writes with, so a replay reproduces them.
      const decidedAt = decidedAtFor(e.event, e.idx, e.receivedAt, e.createdAt);

      // One entry's statements: the record rules' when it is routed, else the
      // event materialiser's.
      let statements: Array<SqlStatement & { derived?: "space" | "global" }>;
      let bundle: StatementBundleSuccess | undefined;
      if (routed) {
        statements = effects.flatMap((effect) =>
          effect.effect === "sql"
            ? [
                {
                  sql: effect.sql,
                  // The effect layer binds positionally; `SqlStatement` also
                  // admits the named form, which no rule uses.
                  params: effect.params as unknown as SqlStatement["params"],
                  derived: effect.target,
                },
              ]
            : [],
        );
      } else {
        const materialised = materialize(
          e.event,
          {
            streamId,
            user: e.user,
            decidedAt,
          },
          e.idx,
        );

        if (materialised.status === "error") {
          stats.materializerErrors++;
          recordFailure(stats, {
            eventId: materialised.eventId,
            type: e.event.$type,
            reason: "materializer",
            message: materialised.message,
          });
          if (isDebugEnabled()) {
            recordMaterialization({
              streamDid: streamId,
              idx: e.idx,
              eventType: e.event.$type,
              eventId: materialised.eventId,
              status: "materializer_error",
              errorMessage: materialised.message,
              bundle: materialised,
            });
          }
          continue;
        }

        bundle = materialised;
        statements = materialised.statements;
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
      for (const stmt of statements) {
        const params = stmt.params;
        // A record rule names its target; the event path's opaque materialiser
        // SQL is still routed by what it writes.
        const derived =
          stmt.derived ??
          (isGlobalDbStatement(stmt.sql) ? "global" : "space");
        chunkSteps.push({
          type: "run",
          sql: stmt.sql,
          params:
            params === undefined
              ? undefined
              : Array.isArray(params)
                ? (params as unknown[])
                : [params],
          derived,
        });
        // Maintain the global entity→space index. A record-routed entry names
        // that write in its effect list; the event path's opaque materialiser
        // SQL is scanned here. Every `insert into entities` statement carries
        // (id, stream_id) as its first two params. Entities with an empty
        // stream_id (e.g. link entities) are skipped — they are never resolved
        // via openSpaceDbForEntity.
        if (!routed && stmt.sql.trim().startsWith("insert into entities")) {
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

      // The event path's projection maintenance — the ordering key and the read
      // projections — inside the same per-event transaction as the entry's own
      // statements. A record-routed entry carries the same steps in its effect
      // list instead.
      if (!routed) {
        chunkSteps.push(...eventProjectionSteps(e, streamId, opts.isBackfill));
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
          // A routed entry has no materialiser bundle; the record's statements
          // stand in, so the debug log still counts what was applied.
          bundle: bundle ?? {
            status: "success",
            event: e.event,
            eventIdx: e.idx,
            user: e.user,
            statements,
            dependsOn: [],
          },
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

    // Capture the chunk's delete targets (the rooms whose windows must be
    // rebuilt) before the chunk's SQL runs. A record-routed delete names no
    // room, so the planner read the room its message was in.
    const pendingDeletes = collectPendingDeletes(
      chunk.filter((_e, i) => (plans[i] ?? null) === null),
    );

    // Compute the max idx for this chunk — used to advance the cursor after
    // the chunk is processed (whether it succeeded or failed).
    let chunkMaxIdx: StreamIndex = 0 as StreamIndex;
    for (const e of chunk) {
      if (e.idx > chunkMaxIdx) chunkMaxIdx = e.idx;
    }

    // Run this chunk's event SQL batched into per-event transactions. Each
    // event's statements go to the per-space DB in a single `transaction`
    // message — one worker round-trip instead of one per statement. The worker
    // runs it as an atomic SQLite transaction, so a failing event rolls back
    // just that event. Global statements (membership edges + entity_space
    // index) go to the global DB in a second single `transaction` message. The
    // cursor is advanced separately below so it also advances past chunks with
    // apply errors, preventing infinite retry loops on every boot.
    //
    // Concurrency: each event is a single atomic transaction message, so the
    // worker serializes them. Same-space sections take a per-space lock shared
    // with `applyBundle`: its SAVEPOINT section must never overlap our
    // `transaction` (a `BEGIN` nested in an open SAVEPOINT fails). Different
    // spaces hold different locks and run in parallel.
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
          // event.
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

    // Delete side-effects: rebuild each affected room's activity window from
    // its remaining messages (dropping the row when the room is empty). Runs
    // after the chunk's SQL — the rows must already be gone for the window
    // rebuild to be correct. This is the same derived-state maintenance
    // `moveMessages` performs on its source room, via the same helper.
    if (pendingDeletes.length > 0) {
      try {
        await applyDeleteSideEffects(db, pendingDeletes);
      } catch (err) {
        // Derived state, not correctness: a failure here must not roll back
        // the delete itself. The window self-heals on the next write to the
        // room.
        log.warn(
          `[materialize] deleteMessage side-effects failed for ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Post-transaction side-effects for this chunk: activity_item upsert, link
    // detection, search indexing and read-state. These need JS logic so they
    // can't be inlined as SQL steps. They run per entry, in log order, across
    // both paths: the read-state writes are last-write-wins per (user, room),
    // so splitting the chunk into two passes would reorder them.
    for (let i = 0; i < chunk.length; i++) {
      const plan = plans[i] ?? null;
      if (plan) {
        await applyRecordSideEffects(db, plan, {
          streamId,
          isBackfill: opts.isBackfill,
          readStateDb: openReadStateDb(),
        });
      } else {
        await applyEventSideEffects(
          db,
          chunk[i]!,
          streamId,
          opts.isBackfill,
          stats.detectedLinks,
          globalDb,
        );
      }

      // The change's derived steps, after the SQL and the side effects that
      // describe the same entry: a recomputed window reads the rows both wrote.
      for (const step of derivedSteps[i]!) {
        try {
          const stored = await applyDerivedStep(db, step, globalDb);
          if (stored.length > 0) stats.detectedLinks.push(...stored);
        } catch (err) {
          // Derived state, not correctness: a failed rebuild must not fail the
          // batch, and the window self-heals on the room's next write.
          log.warn(
            `[materialize] derived step ${step.effect} failed for ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Refresh the global `space_stats` aggregate when this chunk contained an
    // event that can change the space's member/admin edges. One extra worker
    // round-trip per such chunk (not per event: a chunk counts at most once),
    // which is negligible next to materialising the chunk itself, and it keeps
    // the admin dashboard's member-count ordering exact without re-deriving it
    // from every space's DB at read time. Failures are non-fatal: the count is
    // derived data, and the boot sweep plus the read-time refresh both heal it.
    if (globalDb && chunk.some((e) => MEMBERSHIP_EVENT_TYPES.has(e.event.$type))) {
      try {
        // The count is read from `db` (this stream's per-space DB — a
        // membership edge lives there) and written to `globalDb`.
        const memberCount = await selectMemberCount(db, streamId);
        await recordSpaceStats(globalDb, streamId, memberCount);
      } catch (err) {
        log.warn(
          `[materialize] space_stats refresh failed for ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Advance the legacy comp_space.backfilled_to cursor. The authoritative
  // materialization_cursor is advanced per-chunk (above), so it already
  // reflects progress. This cursor is kept for backwards compatibility
  // and only exists for streams that have a comp_space row.
  //
  // `updated_at` is deliberately not touched: the row's clock columns record
  // the last *change* the log made to it, and advancing a cursor is not one.
  await db.transaction([
    {
      type: "run",
      sql: `update comp_space
           set backfilled_to = ?
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
 * The projection-maintenance steps one event-path entry appends after its
 * statements, all inside the same per-event transaction.
 *
 * `sort_idx` is inlined rather than read back: the key is the message's
 * canonical ordering time plus this event's log position, and the time comes
 * from `receivedAt` — the instant the server accepted the event, recorded in
 * the log at append — not from the sender-minted ULID, which a skewed device
 * clock would use to bury a message mid-history for every other client.
 * Reading it from the event's log row rather than the wall clock is what makes
 * a rebuild reproduce the same key live materialisation wrote (see
 * `sortIdx.ts`). A forward reference sorts by the forward event's own time, so
 * it appears at the top of the destination room's timeline rather than at the
 * original's send time.
 *
 * `room_access` and `room_activity` are the denormalised read projections.
 * Live events upsert them; replay invalidates them, so a replayed structural
 * change cannot leave a stale row behind and the read path warms the row from
 * the replayed data on first access. The delete and move paths rebuild the
 * rooms whose windows they invalidate in the chunk's side-effect stage (see
 * `roomDerivedState.ts`).
 */
function eventProjectionSteps(
  e: LoggedEvent,
  streamId: StreamDid,
  isBackfill: boolean,
): ChunkStep[] {
  const steps: ChunkStep[] = [];

  if (e.event.$type === "space.roomy.message.createMessage.v0") {
    const sortIdx = messageSortIdxKey(e.event, e.idx, e.receivedAt, e.createdAt);
    steps.push({
      type: "run",
      sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
      params: [sortIdx, e.event.id],
      derived: "space",
    });
  }

  if (e.event.$type === "space.roomy.message.forwardMessages.v0") {
    const sortIdx = messageSortIdxKey(e.event, e.idx, e.receivedAt, e.createdAt);
    steps.push({
      type: "run",
      sql: "update entities set sort_idx = ? where id = ? and sort_idx is null",
      params: [sortIdx, e.event.id],
      derived: "space",
    });
  }

  const projectionStep = maintainRoomAccess(
    e.event as unknown as Record<string, unknown>,
    streamId,
    isBackfill,
  );
  if (projectionStep) {
    steps.push({
      type: "run",
      sql: projectionStep.sql,
      params: projectionStep.params,
      derived: "space",
    });
  }

  const activityStep = maintainRoomActivity(
    e.event as unknown as Record<string, unknown>,
    isBackfill,
  );
  if (activityStep) {
    steps.push({
      type: "run",
      sql: activityStep.sql,
      params: activityStep.params,
      derived: "space",
    });
  }

  // A room or space rename changes names the feed rows denormalise. Both paths
  // run the same statement, so the projection does not depend on which one
  // applied the change.
  if (
    e.event.$type === "space.roomy.room.createRoom.v0" ||
    e.event.$type === "space.roomy.room.updateRoom.v0"
  ) {
    const roomId = (e.event as Record<string, unknown>).id;
    if (typeof roomId === "string" && roomId !== "") {
      steps.push({
        type: "run",
        sql: refreshActivityMetaStatement(roomId).sql,
        params: refreshActivityMetaStatement(roomId).params as unknown[],
        derived: "space",
      });
    }
  }
  if (e.event.$type === "space.roomy.space.updateSpaceInfo.v0") {
    steps.push({
      type: "run",
      sql: `update activity_item
                set space_name = (select name from comp_info where entity = activity_item.space_id),
                    space_avatar = (select avatar from comp_info where entity = activity_item.space_id)`,
      params: [],
      derived: "space",
    });
  }

  return steps;
}

/**
 * Post-transaction side-effects for one event-path entry: activity_item upsert
 * and link detection. These need JS logic (JSON array manipulation, URL
 * extraction) so they can't be inlined as SQL steps.
 *
 * The message branches here serve the paths that still read events — the
 * `_withEventPath` comparison a test runs, and any kind that has not converted.
 * A converted kind's entry never reaches them.
 */
async function applyEventSideEffects(
  db: DbLike,
  e: LoggedEvent,
  streamId: StreamDid,
  isBackfill: boolean,
  detectedLinks: string[],
  globalDb?: DbLike,
): Promise<void> {
  if (e.event.$type === "space.roomy.message.createMessage.v0" && (e.event as Record<string, unknown>).room) {
    // The instant the log assigned this entry, for the rows this writes.
    const decidedAt = decidedAtFor(e.event, e.idx, e.receivedAt, e.createdAt);
    const bundle: StatementBundleSuccess = {
      status: "success",
      event: e.event,
      eventIdx: e.idx,
      user: e.user,
      statements: [],
      dependsOn: [],
    };
    await applyBundle(
      db,
      bundle,
      { isBackfill, streamId, idx: e.idx, receivedAt: e.receivedAt, createdAt: e.createdAt },
      globalDb,
      openReadStateDb(),
    );

    // Search indexing: enqueue the message for the out-of-band
    // Qdrant indexer — the worker re-reads the materialised rows, so no
    // synchronous search work happens here.
    enqueueIndexMessage(streamId, e.event.id);

    const event = e.event as Record<string, unknown>;
    const body = event.body as
      | { mimeType?: string; data?: { buf: Uint8Array } }
      | undefined;
    let detected: string[] = [];
    if (body?.data?.buf) {
      const mime = body.mimeType ?? "text/markdown";
      const buf = Buffer.from(body.data.buf);
      if (mime === RICHTEXT_MIME) {
        // New format: URLs come from `#link` facet URIs, not regex scanning.
        const blocks = decodeRichTextBody(mime, buf);
        detected = await detectAndStoreLinksFromUrls(
          db,
          e.event.id,
          blocks ? extractFacetUrls(blocks) : [],
          decidedAt,
        );
      } else {
        // Legacy text/markdown bodies keep the regex extraction path.
        const content = decodeContent(mime, buf);
        detected = await detectAndStoreLinks(db, e.event.id, content, decidedAt);
      }
    }
    // A link attachment is materialised as its own entity (`uri?message=<id>`),
    // so body scanning never sees it: a message whose entire payload is a link
    // (a bridged embed, say) has no other source. The canonical URL is what the
    // embed store is keyed by, and it is the same URL body detection records,
    // so the two collapse to one row here.
    const attachmentUrls = linkAttachmentUrls(
      event.extensions as Record<string, unknown> | undefined,
    );
    if (detected.length > 0) detectedLinks.push(...detected);
    if (attachmentUrls.length > 0) detectedLinks.push(...attachmentUrls);
    if (globalDb) {
      // Record the body link entities in the global entity→space index so they
      // resolve to this space (they carry an empty stream_id in the per-space
      // DB). Attachment entities are per-message (`?message=`) and have no
      // stable global id, so only body URLs are indexed.
      for (const url of detected) {
        await globalDb.run(
          `insert or ignore into entity_space (entity_id, space_did) values (?, ?)`,
          [url, streamId],
        );
      }
      // Dual-write the global pending-links index so the centralized embed
      // sweeper can find this work without iterating every per-space DB.
      // `insert or ignore` keeps the row idempotent across re-materialisation
      // and collapses an attachment link whose canonical URL was already
      // detected in the body.
      for (const url of new Set([...detected, ...attachmentUrls])) {
        await globalDb.run(
          `insert or ignore into pending_links (space_did, message_id, url, created_at)
           values (?, ?, ?, ?)`,
          [streamId, e.event.id, url, Date.now()],
        );
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
  } else if (
    e.event.$type === "space.roomy.message.moveMessages.v0" &&
    "toRoomId" in e.event
  ) {
    // The per-event statements above only rewrote `entities.room`. The
    // derived state (sort_idx, activity windows, read-state) is applied by
    // `applyBundle`'s move branch — the same route createMessage takes
    // through this function, with an empty statement list because the event
    // SQL has already been applied. Single call site: routing moves through
    // applyBundle here (rather than calling the helper directly) keeps ONE
    // owner of the side effects, so they can never be applied twice.
    const bundle: StatementBundleSuccess = {
      status: "success",
      event: e.event,
      eventIdx: e.idx,
      user: e.user,
      statements: [],
      dependsOn: [],
    };
    await applyBundle(db, bundle, { isBackfill, streamId, idx: e.idx, receivedAt: e.receivedAt, createdAt: e.createdAt }, globalDb, openReadStateDb());

    // Re-index every moved message: the search worker reads the message's
    // `room` from the per-space DB, and Qdrant filters on it, so a moved
    // message must be re-upserted to leave the source room's results.
    const messageIds = (e.event as Record<string, unknown>).messageIds;
    if (Array.isArray(messageIds)) {
      for (const id of messageIds) {
        if (typeof id === "string") enqueueIndexMessage(streamId, id);
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
