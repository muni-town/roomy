/**
 * Qdrant backfill sweeper (Phase 2).
 *
 * On boot, re-index messages that are missing from Qdrant. The appserver
 * keeps a per-space cursor in the global DB (`search_backfill_cursor`); each
 * sweep cycle walks one space's messages after its cursor, upserts them
 * (idempotent — point ids are deterministic UUIDv5), and advances the
 * cursor.
 *
 * Wipe repair: when the `messages` collection has been (re)created — e.g.
 * the Qdrant deployment was wiped — `ensureMessagesCollection` reports the
 * creation and the sweeper clears every cursor so the full corpus is
 * re-indexed from the beginning. Cursor-less spaces are picked in
 * updated_at round-robin order (absent cursors first, oldest first).
 *
 * Mirrors the embed sweeper's `pending_links` pattern: a global-DB-backed
 * backlog drained by a background loop with poke support.
 */

import type { DbLike } from "../db/types.ts";
import { openSpaceDb } from "../db/db.ts";
import { getQdrantClient, ensureMessagesCollection, upsertMessages, upsertMessage, type QdrantClientLike, type QueuedMessageUpsert } from "./qdrantSearch.ts";
import { encodeSparse } from "./bm25.ts";
import { extractMessageText } from "./text.ts";
import { log } from "../log.ts";

/** Max messages to re-index per sweep cycle. */
const SWEEP_BATCH = 100;
/** How often to poll for pending spaces while idle. */
const IDLE_POLL_MS = 60_000;

// ─── Singleton state ────────────────────────────────────────────────────

let sweeperGlobalDb: DbLike | undefined;
let started = false;
/** Resolved when the background loop exits. Used by stopSearchBackfill. */
let loopPromise: Promise<void> | undefined;
/** Resolved by pokeSearchBackfill to wake an idle loop immediately. */
let wake: (() => void) | null = null;
/** Consecutive DB/Qdrant errors — escalates backoff so a down service doesn't tight-loop. */
let dbErrorCount = 0;
/** Timestamp (ms) until which the sweeper should skip cycles. */
let dbBackoffUntil = 0;

// ─── Stats (for /health/search) ─────────────────────────────────────────
let statsBackfilled = 0;
/** Upserts that failed (e.g. Qdrant 507) — surfaced on /health/search. */
let statsFailed = 0;
/** Message of the most recent sweep error (null when none). */
let statsLastError: string | null = null;

// ─── Lifecycle ──────────────────────────────────────────────────────────

export interface SearchBackfillOpts {
  /** Global DB — the `search_backfill_cursor` table lives here. */
  globalDb: DbLike;
}

/**
 * Start the backfill sweeper. Idempotent — safe to call multiple times.
 * Called once at appserver startup (see `index.ts`).
 */
export function startSearchBackfill(opts: SearchBackfillOpts): void {
  if (started) return;
  started = true;
  sweeperGlobalDb = opts.globalDb;
  loopPromise = runBackfillLoop().catch((err) => {
    log.error("[search-backfill] loop crashed:", err);
  });
}

/** Wake the sweeper to run a cycle immediately. Cheap no-op when busy. */
export function pokeSearchBackfill(): void {
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
}

/** Wait for the background loop to exit. Idempotent. Used by tests. */
export async function stopSearchBackfill(): Promise<void> {
  started = false;
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
  const p = loopPromise;
  loopPromise = undefined;
  if (p) await p;
}

/** Snapshot of sweeper state for the `/health/search` endpoint. */
export function searchBackfillStats(): {
  backfilled: number;
  failed: number;
  dbBackoffActive: boolean;
  /** Consecutive DB/Qdrant errors (escalates backoff). */
  errorCount: number;
  /** Message of the most recent sweep error, or null when none. */
  lastError: string | null;
} {
  return {
    backfilled: statsBackfilled,
    failed: statsFailed,
    dbBackoffActive: Date.now() < dbBackoffUntil,
    errorCount: dbErrorCount,
    lastError: statsLastError,
  };
}

/** Reset stats (tests only. Does not stop a running loop). */
export function _resetSearchBackfill(): void {
  statsBackfilled = 0;
  statsFailed = 0;
  dbErrorCount = 0;
  dbBackoffUntil = 0;
  statsLastError = null;
}

// ─── Loop ───────────────────────────────────────────────────────────────

async function runBackfillLoop(): Promise<void> {
  const globalDb = sweeperGlobalDb;
  if (!globalDb) return;

  for (;;) {
    if (!started) return; // allow clean exit via stopSearchBackfill
    try {
      const full = await sweepCycle(globalDb);
      if (full) continue;
      await waitForId(IDLE_POLL_MS);
    } catch (err) {
      // Outer resilience (mirrors the embed sweeper): an unexpected throw
      // must not permanently kill the process-wide loop.
      statsLastError = err instanceof Error ? err.message : String(err);
      log.error("[search-backfill] sweep threw (continuing):", err);
      await waitForId(IDLE_POLL_MS);
    }
  }
}

/**
 * Run one sweep cycle: pick the space with the oldest cursor, index its
 * messages after the cursor in a batched Qdrant upsert, and advance the
 * cursor. Returns true when the batch was full (more likely remain → loop
 * without waiting).
 */
export async function sweepCycle(globalDb: DbLike): Promise<boolean> {
  if (!started) return false;
  if (Date.now() < dbBackoffUntil) {
    await waitForId(dbBackoffUntil - Date.now());
    return false;
  }

  const client = getQdrantClient();
  if (!client) return false; // Qdrant not configured — nothing to do

  try {
    const created = await ensureMessagesCollection(client);
    if (created) await clearAllCursors(globalDb);
  } catch (err) {
    markDbError(err);
    return false;
  }

  const spaceDid = await nextCursorSpace(globalDb);
  if (spaceDid === null) return false;

  return sweepOneSpace(globalDb, client, spaceDid);
}

/** Index one space's pending messages after its cursor. Returns true when the batch was full. */
async function sweepOneSpace(
  globalDb: DbLike,
  client: QdrantClientLike,
  spaceDid: string,
): Promise<boolean> {
  const spaceDb = openSpaceDb(spaceDid);
  const cursorRow = await globalDb
    .query("select cursor from search_backfill_cursor where space_did = ?")
    .get<{ cursor: string }>(spaceDid);
  const cursor = cursorRow?.cursor ?? null;

  const rows = await spaceDb
    .query(
      `select e.id as id, e.room as room, cc.mime_type as mime_type,
              cc.data as data, cc.timestamp as timestamp
         from entities e
         left join comp_content cc on cc.entity = e.id
        where e.stream_id = ?
          and e.room is not null
          and cc.entity is not null
          and (? is null or e.id > ?)
        order by e.id
        limit ?`,
    )
    .all<{
      id: string;
      room: string;
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      timestamp: number | null;
    }>([spaceDid, cursor, cursor, SWEEP_BATCH]);

  let indexedCount = 0;
  let failedCount = 0;
  /** Id of the last row in the leading run of non-failed rows (indexed or
   *  no indexable text). Once a row fails, the cursor must not advance past
   *  it — so this stops updating at the first failure. */
  let lastOkId: string | null = null;
  let batchFailed = false;

  if (rows.length === 0) {
    // No sweepable rows (e.g. a space with entity_space entries but no
    // messages). Without a cursor this space sorts first in
    // `nextCursorSpace` (coalesce(updated_at, 0) = 0) and is picked on
    // every cycle, starving every other space — the sweep never advances
    // and `backfilled` stays 0 with no error or backoff. Stamp a cursor
    // (sentinel "" when none) AND refresh `updated_at` on every 0-row
    // visit so the space rotates to the back of the round-robin — a
    // stale `updated_at` would re-pick it forever once all empty spaces
    // are stamped. The cursor value is opaque (never compared), so a
    // sentinel is safe; a fully-swept space keeps its cursor and just
    // bumps its recency.
    await setCursor(globalDb, spaceDid, cursor ?? "");
    // Emit a progress line so operators can see the empty space was visited
    // (without it, a sparse space's visit leaves no telemetry trace).
    log.info("[search-backfill] progress", {
      spaceDid,
      cursor: cursor ?? "",
      rows: 0,
      indexed: 0,
      failed: 0,
      backfilled: statsBackfilled,
      errorCount: dbErrorCount,
      dbBackoffActive: Date.now() < dbBackoffUntil,
    });
    return false;
  }

  // Build the batched upsert payload. One HTTP call to Qdrant for the whole
  // batch instead of one call per message — the dominant cost when
  // re-indexing dense spaces.
  const toUpsert: QueuedMessageUpsert[] = [];
  for (const row of rows) {
    const text = extractMessageText(row.mime_type, row.data);
    if (text === "") {
      // Nothing to index — the cursor may advance past it (unless a row
      // before it already failed).
      if (!batchFailed) lastOkId = row.id;
      continue;
    }
    try {
      const threadId = await resolveThreadId(spaceDb, row.room);
      toUpsert.push({
        messageId: row.id,
        sparse: encodeSparse(text),
        payload: {
          spaceDid,
          roomId: row.room,
          threadId,
          authorDid: "",
          timestamp: row.timestamp != null
            ? new Date(row.timestamp).toISOString()
            : new Date().toISOString(),
        },
      });
    } catch (err) {
      failedCount++;
      batchFailed = true;
      log.warn(`[search-backfill] encode failed for ${row.id}:`, err);
    }
  }

  if (toUpsert.length > 0) {
    try {
      await upsertMessages(client, toUpsert);
      indexedCount = toUpsert.length;
      // Advance through the batch (including trailing empty-text rows that
      // were already marked Ok above — `batchFailed` is still false here).
      if (!batchFailed) lastOkId = rows[rows.length - 1]!.id;
    } catch (err) {
      // A batch-wide failure (e.g. a Qdrant 507 / payload-index hiccup). We
      // must NOT lose the per-message failure granularity: individually
      // upsert each so a genuinely-failed message keeps the cursor before
      // it (retried next cycle) while the others still make progress and
      // advance. One batched Qdrant call that errored is opaque — it
      // doesn't tell us WHICH point failed — so we retry point-by-point to
      // preserve the never-skip-past-a-failure guarantee.
      log.warn(`[search-backfill] batched upsert failed for ${spaceDid} (falling back per-message):`, err);
      for (const q of toUpsert) {
        try {
          await upsertMessage(client, q.messageId, q.sparse, q.payload);
          indexedCount++;
          if (!batchFailed) lastOkId = q.messageId;
        } catch (perErr) {
          failedCount++;
          batchFailed = true;
          log.warn(`[search-backfill] upsert failed for ${q.messageId}:`, perErr);
        }
      }
    }
  }

  if (indexedCount > 0) statsBackfilled += indexedCount;
  if (failedCount > 0) statsFailed += failedCount;
  if (indexedCount > 0 || rows.length > 0) markDbOk();

  if (lastOkId !== null) {
    // Advance only past the last non-failed row. A failed upsert (e.g. a
    // Qdrant 507) keeps the cursor before it, so the next cycle retries it
    // instead of skipping it forever (the pre-fix behaviour skipped every
    // failed batch — 1,758 messages lost in the Sep 2026 507 incident).
    await setCursor(globalDb, spaceDid, lastOkId);
  } else if (rows.length > 0) {
    // Every sweepable row failed. Do NOT advance the cursor — retry the
    // same batch next cycle. Stamp `updated_at` so the space still rotates
    // in the round-robin (a stuck space must not starve the others while
    // Qdrant is down).
    await setCursor(globalDb, spaceDid, cursor ?? "");
  }

  // Progress telemetry (Loki): one structured line per cycle. `backfilled`
  // is process-local (resets on restart), so `cursor` — which persists in
  // the global DB — is the cross-restart progress signal. Query in Grafana
  // with `{scope="search-backfill"} | json | unwrap backfilled`.
  log.info("[search-backfill] progress", {
    spaceDid,
    cursor: cursor ?? "",
    rows: rows.length,
    indexed: indexedCount,
    failed: failedCount,
    backfilled: statsBackfilled,
    errorCount: dbErrorCount,
    dbBackoffActive: Date.now() < dbBackoffUntil,
  });

  return rows.length >= SWEEP_BATCH;
}

/**
 * Run backfill catch-up: drain pending spaces in a tight loop until no cursor-less
 * spaces remain and the last cycle was not a full batch.
 *
 * The background loop naps IDLE_POLL_MS after a non-full cycle, which is the
 * right cadence when caught up but agonisingly slow after a reset or cold start
 * (the Roomy space model is sparse — thousands of mostly-empty spaces each
 * yield a partial batch, so a 60s nap per space would take days). This runs the
 * same sweepCycle back-to-back, sleeping only between batches, so it chews
 * through the sparse backlog and the dense hotspots as fast as Qdrant and the
 * DB pool allow.
 *
 * Used by the admin runSearchBackfill procedure to trigger a whole-corpus
 * re-index on demand without waiting on the background loop's idle cadence.
 */
export async function runBackfillCatchUp(globalDb: DbLike): Promise<void> {
  // Prime the singleton state so sweepCycle runs even when the background
  // loop hasn't been started (e.g. e2e/background-workers-disabled, or a
  // one-shot admin-triggered re-index before boot).
  sweeperGlobalDb = globalDb;
  started = true;
  for (;;) {
    const full = await sweepCycle(globalDb);
    if (full) continue; // keep going — more in this dense space / cursor-less backlog
    if (!getQdrantClient()) return; // Qdrant not configured — nothing can be indexed
    if (await hasCursorlessBacklog(globalDb)) continue; // sparse tail still ahead
    return;
  }
}

/** True when any space is missing a `search_backfill_cursor` row (backlog). */
async function hasCursorlessBacklog(globalDb: DbLike): Promise<boolean> {
  const row = await globalDb
    .query(
      `select s.space_did as id
         from (select distinct space_did from entity_space) s
         left join search_backfill_cursor c on c.space_did = s.space_did
        where c.space_did is null
        limit 1`,
    )
    .get<{ id: string }>();
  return row !== null;
}

/** Pick the space whose cursor is oldest/absent (round-robin fairness). */
async function nextCursorSpace(globalDb: DbLike): Promise<string | null> {
  const row = await globalDb
    .query(
      `select s.space_did as id
         from (select distinct space_did from entity_space) s
         left join search_backfill_cursor c on c.space_did = s.space_did
        order by coalesce(c.updated_at, 0) asc
        limit 1`,
    )
    .get<{ id: string }>();
  return row?.id ?? null;
}

async function setCursor(
  globalDb: DbLike,
  spaceDid: string,
  cursor: string,
): Promise<void> {
  await globalDb.run(
    `insert into search_backfill_cursor (space_did, cursor, updated_at)
     values (?, ?, ?)
     on conflict (space_did) do update set
       cursor = excluded.cursor,
       updated_at = excluded.updated_at`,
    [spaceDid, cursor, Date.now()],
  );
}

/** Clear every cursor (collection was wiped — re-index everything). */
async function clearAllCursors(globalDb: DbLike): Promise<void> {
  await globalDb.run("delete from search_backfill_cursor");
}

/** The message's own room when that room is a thread, else null. */
async function resolveThreadId(db: DbLike, roomId: string): Promise<string | null> {
  const row = await db
    .query("select label from comp_room where entity = ?")
    .get<{ label: string | null }>(roomId);
  return row?.label === "space.roomy.thread" ? roomId : null;
}

/** Resolve after `ms`, or immediately when {@link pokeSearchBackfill} fires. */
function waitForId(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    wake = null;
    resolve();
  }, ms);
  wake = () => {
    clearTimeout(timer);
    resolve();
  };
  return promise;
}

/** Escalate backoff on consecutive errors (a down Qdrant shouldn't tight-loop). */
function markDbError(err: unknown): void {
  dbErrorCount = Math.min(dbErrorCount + 1, 8);
  dbBackoffUntil = Date.now() + Math.min(60_000 * 2 ** (dbErrorCount - 1), 30 * 60_000);
  statsLastError = err instanceof Error ? err.message : String(err);
  log.warn(
    `[search-backfill] error (#${dbErrorCount}); backing off ${Math.round((dbBackoffUntil - Date.now()) / 1000)}s:`,
    err,
  );
}

/** Reset the backoff after a successful cycle. */
function markDbOk(): void {
  if (dbErrorCount !== 0) dbErrorCount = 0;
  if (dbBackoffUntil !== 0) dbBackoffUntil = 0;
}
