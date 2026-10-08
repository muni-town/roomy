/**
 * Memory bounds for the DB worker's caches.
 *
 * Every open SQLite connection owns a native page cache, and the worker's
 * statement map holds a native compiled statement per entry. Neither is
 * visible to — or reclaimable by — the JS GC, so both are bounded here rather
 * than left to grow with traffic. Each bound is env-overridable so an operator
 * can trade cache for headroom without a rebuild.
 */

/**
 * Default open per-space DBs per worker before LRU eviction. Together with
 * `DEFAULT_SPACE_DB_CACHE_KIB` this is the per-worker native-memory ceiling for
 * the connection cache: `maxSpaceDbs × cache size`, times the pool size.
 */
export const DEFAULT_MAX_SPACE_DBS = 100;

/**
 * Default live prepared statements per worker before the least-recently-used
 * one is finalized and dropped. Bounds the worker's statement map against a
 * caller that prepares per invocation and never finalizes: an abandoned handle
 * is the first eviction candidate, while one a caller keeps using survives.
 */
export const DEFAULT_MAX_PREPARED_STMTS = 256;

/**
 * Default page cache per connection, in KiB (`PRAGMA cache_size`; negative
 * means KiB). A quarter of SQLite's 2 MiB default: per-space reads resolve on
 * the room/message index pages they touch, and the open-time and boot-sweep
 * `PRAGMA optimize` keeps the planner off the partition scans that would want
 * more cache (see `docs/per-space-stats.md`). Measured on a 131k-entity space
 * DB: the 23-id lookup `readPositions`/`userActiveThreads` issue takes 331 ms
 * per 20k calls at 512 KiB against 353 ms at the default — the bound is free.
 */
export const DEFAULT_SPACE_DB_CACHE_KIB = 512;

/** The DB worker's cache bounds, read from the environment. */
export interface DbMemoryBounds {
  /** Open per-space DBs per worker before LRU eviction. */
  maxSpaceDbs: number;
  /** Live prepared statements per worker before LRU finalize. */
  maxPreparedStmts: number;
  /** Page cache per connection, in KiB (`PRAGMA cache_size`, negative = KiB). */
  spaceDbCacheKib: number;
}

/** Parse a `>= 1` integer env var, falling back when unset or malformed. */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Read the three bounds from the environment: `APPSERVER_MAX_SPACE_DBS`,
 * `APPSERVER_MAX_PREPARED_STMTS` and `APPSERVER_SPACE_DB_CACHE_KIB`.
 *
 * Read once on the main thread and passed to each worker through its init
 * message (see `PoolInitOptions`), so the worker's configuration has one
 * source and a pool can be initialised with explicit bounds in tests.
 */
export function dbMemoryBoundsFromEnv(): DbMemoryBounds {
  return {
    maxSpaceDbs: positiveIntFromEnv("APPSERVER_MAX_SPACE_DBS", DEFAULT_MAX_SPACE_DBS),
    maxPreparedStmts: positiveIntFromEnv(
      "APPSERVER_MAX_PREPARED_STMTS",
      DEFAULT_MAX_PREPARED_STMTS,
    ),
    spaceDbCacheKib: positiveIntFromEnv(
      "APPSERVER_SPACE_DB_CACHE_KIB",
      DEFAULT_SPACE_DB_CACHE_KIB,
    ),
  };
}
