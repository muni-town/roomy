/**
 * SQLite handles for the appserver.
 *
 * Phase 4 (worker pool): the per-space DBs run on a pool of N `Bun.Worker`
 * threads, hash-routed by `spaceDid` (`hash(spaceDid) % N`), so different
 * spaces' materialization and reads run on different threads in parallel.
 * Dedicated workers each own one of the shared DBs: a "global" worker, a
 * "readstate" worker and an "events" worker. There is no monolithic
 * materialised DB — the per-space DBs are the source of truth for space data
 * (Phase 3 of docs/plans/per-space-dbs.md).
 *
 * This module owns the shared `DatabasePool` and hands out routed handles:
 * `openDb()` → the router (event-log DB by default, with `forSpace`/`global`/
 * `readState`/`events`/`backfillEntitySpace` dispatch), `openSpaceDb(spaceDid)`
 * → per-space DB, `openGlobalDb()` → global DB, `openReadStateDb()` →
 * read-state DB, `openEventsDb()` → event-log DB.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncDatabase } from "./asyncDatabase.ts";
import { DatabasePool, PooledDatabase } from "./pool.ts";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";
import { dbPath, spacesDir } from "./paths.ts";

/**
 * Per-space DB schema version (`data/spaces/*.sqlite`). Bump whenever
 * schema-space.sql changes — a bump wipes and re-derives every per-space DB
 * (from the event log via re-materialisation).
 */
export const SPACE_SCHEMA_VERSION = "2";

/**
 * Global DB schema version (`data/global.sqlite`). Bump whenever
 * schema-global.sql changes. Global changes are additive and migrate in place;
 * never wipe this DB on a version bump because per-space cursors do not track
 * whether its cross-space indexes were rebuilt.
 *
 * `.2`: added the global `profiles` table (authoritative per-user Roomy
 * profile).
 *
 * `.3`: added the global `entity_space` entity→space index (Phase 3),
 * replacing the monolithic DB's `entities.stream_id` lookup for
 * `openSpaceDbForEntity`.
 *
 * `.4`: added the global `pending_links` embed-sweeper index (Phase 3),
 * dual-written during materialization so the sweeper can find pending
 * embed links across all per-space DBs with one query.
 *
 * `.5`: added the global `mentions` index (mentions subscription) — one row
 * per (mentioned DID, message), dual-written during materialization so the
 * `mentions:<did>` sync topic can backfill via getMentions and deleteMessage
 * can resolve a deleted message's mentioned DIDs.
 *
 * `.6`: added resumable global post-migration tracking and schedules a
 * one-time repair of active joined-space edges from per-space membership
 * truth. This recovers global DBs wiped by the v4→v5 deployment bug.
 */
export const GLOBAL_SCHEMA_VERSION = "7";

/** Default pool size (per-space workers). Override via `APPSERVER_DB_POOL_SIZE`. */
const DEFAULT_POOL_SIZE = 4;

let pool: DatabasePool | null = null;
let router: PooledDatabase | null = null;
let globalDb: AsyncDatabase | null = null;

export interface OpenDbOptions {
  /** Event-log DB path or `:memory:`. Defaults to `dbPath("roomy-events.sqlite")` (under `DATA_DIR`). */
  path?: string;
  /** If true, skip the process-wide singleton (useful for tests). */
  isolated?: boolean;
}

function poolSizeFromEnv(): number {
  const raw = process.env.APPSERVER_DB_POOL_SIZE;
  if (!raw) return DEFAULT_POOL_SIZE;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_POOL_SIZE;
}

/**
 * Open the process-wide router handle (the "main" remaining DB). Default
 * operations target the event-log DB (`data/roomy-events.sqlite`) on the
 * worker for its own shared DB; `forSpace`/`global`/`readState`/`events`/
 * `backfillEntitySpace` dispatch to the correct worker.
 *
 * `opts.path` is accepted for backwards compatibility with tests that pass
 * `:memory:`; it selects the event-log DB path. `opts.isolated` spins up a
 * dedicated pool (tests).
 */
export function openDb(opts: OpenDbOptions = {}): PooledDatabase {
  if (!opts.isolated && router) return router;

  const path = opts.path ?? dbPath("roomy-events.sqlite");
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
  const size = opts.isolated ? 1 : poolSizeFromEnv();
  const p = new DatabasePool(size, workerPath);
  const isMemory = path === ":memory:";
  void p.init({
    readStateDbPath: isMemory ? ":memory:" : dbPath("roomy-readstate.sqlite"),
    eventsDbPath: path,
    // In-memory event-log DB (tests) ⇒ in-memory derived DBs too, so tests
    // never touch the filesystem. The worker applies the same fallback when
    // these are absent, but db.ts pins them so env vars can't leak files
    // into a :memory: test run.
    spacesDir: isMemory ? ":memory:" : spacesDir(),
    globalDbPath: isMemory ? ":memory:" : dbPath("global.sqlite"),
    readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
    spaceSchemaVersion: SPACE_SCHEMA_VERSION,
    globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
  }).catch(() => {
    // Error already propagates via the first queued request's response.
  });

  if (!opts.isolated) {
    pool = p;
    router = p.router();
  }
  return p.router();
}

/** Return the singleton router, or throw if not yet opened. */
export function getDb(): PooledDatabase {
  if (!router) throw new Error("Database not opened. Call openDb() first.");
  return router;
}

/**
 * Return a handle that routes every request to the per-space DB for
 * `spaceDid` (`data/spaces/<spaceDid>.sqlite`), pinned to the pool worker
 * that owns it. The space DB is created lazily on first use in that worker
 * and populated by re-materialising the stream from the event log.
 *
 * Safe to call before `openDb()`; the routed handle's first request will
 * resolve against whichever pool is active. Callers that rely on the worker
 * being initialised should call `openDb()` first (the appserver boot path
 * always does).
 */
export function openSpaceDb(spaceDid: string): AsyncDatabase {
  ensurePool();
  return pool!.forSpace(spaceDid);
}

/**
 * Resolve the space DID that owns `entityId` (a room or message entity) by
 * reading the global `entity_space` index, then return a handle that routes
 * requests to that space's per-space DB.
 *
 * Phase 3: room/message-scoped handlers need to know which per-space DB to
 * read from, but their XRPC params only carry the room/message id. The
 * global `entity_space` index (populated during materialization) replaces
 * the monolithic DB's `entities.stream_id` lookup. Returns `null` when the
 * entity doesn't exist (the caller decides 404 vs 400).
 */
export async function openSpaceDbForEntity(
  entityId: string,
): Promise<AsyncDatabase | null> {
  const global = openGlobalDb();
  const row = await global
    .query("select space_did from entity_space where entity_id = ?")
    .get<{ space_did: string }>(entityId);
  if (!row) return null;
  return openSpaceDb(row.space_did);
}

/**
 * Return a handle that routes every request to the global DB
 * (`data/global.sqlite`), on the global worker. The global DB is created
 * lazily on first use and holds `joinedSpace`/`leftSpace` edges, the global
 * `profiles` table, and the `entity_space` entity→space index.
 */
export function openGlobalDb(): AsyncDatabase {
  ensurePool();
  if (!globalDb) {
    globalDb = pool!.global();
  }
  return globalDb;
}

/**
 * Return the global DB handle if the pool is initialised, or `null`
 * otherwise. Unlike `openGlobalDb()`, this does NOT lazily initialise the
 * pool — used by code paths that may run against a raw in-memory `Database`
 * in tests (where the global DB isn't set up) and should skip the global
 * write rather than spin up a pool.
 */
export function tryOpenGlobalDb(): AsyncDatabase | null {
  if (!pool) return null;
  if (!globalDb) {
    globalDb = pool.global();
  }
  return globalDb;
}

/**
 * Return a handle that routes every request to the read-state DB
 * (`data/roomy-readstate.sqlite`), on the readstate worker.
 */
export function openReadStateDb(): AsyncDatabase {
  ensurePool();
  return pool!.readState();
}

/**
 * Return a handle that routes every request to the event-log DB
 * (`data/roomy-events.sqlite`), on the events worker.
 */
export function openEventsDb(): AsyncDatabase {
  ensurePool();
  return pool!.events();
}

function ensurePool(): void {
  if (!pool) {
    // Initialise the shared pool (with default paths) so routed handles
    // have a link. Mirrors what openDb() does for the router.
    openDb();
  }
}

/**
 * Per-worker pool stats for `/health/pool` (Phase 4 observability). Returns
 * `null` when the pool isn't initialised.
 */
export function poolStats(): {
  size: number;
  spaceWorkers: Array<{ pending: number }>;
  globalWorker: { pending: number };
  readStateWorker: { pending: number };
  eventsWorker: { pending: number };
} | null {
  return pool?.stats() ?? null;
}

/**
 * Close the process-wide database singleton. Used by tests to reset state.
 * Terminates every worker immediately so in-flight requests fail fast.
 */
export function closeDb(): void {
  if (pool) {
    pool.close();
    pool = null;
  }
  router = null;
  globalDb = null;
}
