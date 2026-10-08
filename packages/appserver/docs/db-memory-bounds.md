# DB worker memory bounds

The DB workers hold native memory that the JS GC cannot see or reclaim: every
open SQLite connection owns a page cache, and every live prepared statement is
a compiled statement. Both are bounded by `src/db/bounds.ts`, read from the
environment once at pool open and passed to each worker through its init
message. `/health/pool` and `/metrics` report the live counts against those
bounds.

## The bounds

| Bound | Env var | Default | Term it caps |
|---|---|---|---|
| Open space DBs per worker | `APPSERVER_MAX_SPACE_DBS` | 100 | Connections held in a worker's LRU cache |
| Page cache per connection | `APPSERVER_SPACE_DB_CACHE_KIB` | 512 | Native page cache of each open connection (KiB) |
| Live prepared statements per worker | `APPSERVER_MAX_PREPARED_STMTS` | 256 | Compiled statements held in the worker's statement map |

Each takes effect when the pool opens, so a change needs a restart. A malformed
or non-positive value falls back to the default rather than producing a zero
bound (which would close every connection, or evict every statement).

The per-worker native-memory ceiling for the connection cache is therefore
`maxSpaceDbs × cacheKib`, times the pool size (`APPSERVER_DB_POOL_SIZE`,
default 8). At the defaults that is 100 × 512 KiB × 8 ≈ 400 MiB, against
~1.5 GiB when each of up to 800 connections carried SQLite's own 2 MiB default.

## Page cache

SQLite's `DEFAULT_CACHE_SIZE` is 2 MiB (`-2000` KiB) per connection. `openDb`
sets `PRAGMA cache_size = -<APPSERVER_SPACE_DB_CACHE_KIB>` on every per-space
connection, so the ceiling is stated rather than inherited from the SQLite
build.

512 KiB is not a read-path regression: a per-space read resolves on the
room/message index pages it touches, and the open-time and boot-sweep
`PRAGMA optimize` keeps the planner off the partition scans that would want a
larger cache (see `per-space-stats.md`). Measured on a 131k-entity space DB,
the 23-id lookup `readPositions`/`userActiveThreads` issue takes 331 ms per 20k
calls at 512 KiB against 353 ms at the 2 MiB default.

`PRAGMA mmap_size = 0` is also set explicitly. This SQLite build already
defaults memory mapping off (`DEFAULT_MMAP_SIZE=0`), but the bound must not
depend on a compile-time default: a build that mapped the file would add
file-backed pages beyond the `cache_size` ceiling, and those would not show up
in the connection counts `poolStats()` reports.

## Prepared statements

The worker keeps a compiled statement per prepared handle until it is
finalized. `handlePrepare` evicts the least-recently-used handle once the map
reaches `APPSERVER_MAX_PREPARED_STMTS`, and every `prepareRun`/`prepareAll`/
`prepareGet` refreshes its handle's recency. A caller that prepares per
invocation and never finalizes therefore evicts its own abandoned statements,
while a handle a caller keeps executing survives.

One-shot writes should use `run`, which compiles through the worker's SQL cache
(keyed by SQL text, so bounded by the number of distinct statements) instead of
holding a handle by call count. The mark-as-read path and the hourly thread
activity purge both go through `run` for this reason.

## Observability

`/health/pool` reports, per worker, `pending`, `openSpaceDbs`, `preparedStmts`,
`cacheKib`, `maxSpaceDbs` and `maxPreparedStmts`; `/metrics` exports
`roomy_db_open_space_dbs{worker}`, `roomy_db_space_cache_kib` and
`roomy_db_max_space_dbs`. A worker that does not answer the stats round-trip
within 250 ms reports zeros rather than holding the scrape — the health route
stays readable exactly when a wedged worker makes it matter.
