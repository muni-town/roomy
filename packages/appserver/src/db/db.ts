/**
 * SQLite handles for the appserver.
 *
 * The per-space DBs run on a pool of N `Bun.Worker` threads, hash-routed by
 * `spaceDid` (`hash(spaceDid) % N`), so different spaces' materialization and
 * reads run on different threads in parallel.
 * Dedicated workers each own one of the shared DBs: a "global" worker, a
 * "readstate" worker and an "events" worker. The per-space DBs are the source
 * of truth for space data.
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
 * Global DB schema version (`data/global.sqlite`) — re-exported from the
 * version manifest (`./globalVersions.ts`). Bump by adding a version to
 * `GLOBAL_MIGRATIONS`; the constant and the async-task key type both follow.
 *
 * Global changes are additive and migrate in place; never wipe this DB on a
 * version bump because per-space cursors do not track whether its cross-space
 * indexes were rebuilt. See `globalVersions.ts` for the per-version history.
 */
import { GLOBAL_SCHEMA_VERSION } from "./globalVersions.ts";
export { GLOBAL_SCHEMA_VERSION };

/**
 * Default pool size (per-space workers). Override via `APPSERVER_DB_POOL_SIZE`.
 *
 * Spaces are pinned to a worker by `hashSpace(spaceDid) % size`. At size 4 the
 * appserver's two highest-traffic spaces collided, so all their reads + bridge
 * materialization serialized on one thread — the space-worker saturation that
 * drove the system-worker-split diagnosis (see per-space-dbs.md). 8 spreads the
 * hot spaces onto distinct workers. Raise/lower via `APPSERVER_DB_POOL_SIZE`.
 */
const DEFAULT_POOL_SIZE = 8;

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
 * Room/message-scoped handlers need to know which per-space DB to
 * read from, but their XRPC params only carry the room/message id. The
 * global `entity_space` index (populated during materialization) resolves
 * the owning space. Returns `null` when the
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
 * Per-worker pool stats for `/health/pool`. Returns `null` when the pool
 * isn't initialised.
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
