/**
 * Single source of truth for the per-space schema version and its migrations.
 *
 * Per-space DBs (`data/spaces/<spaceDid>.sqlite`) upgrade **in place**. A bump
 * no longer implies a full rematerialisation: the worker advances structural
 * versions synchronously at open, and the boot runner executes the async data
 * migrations, exactly as the global DB does (`globalVersions.ts`) and the
 * read-state DB does (`readStateVersions.ts`). Only a migration that fails —
 * or a DB stamped with a version this manifest cannot start from — falls back
 * to the blue-green rebuild (`streams/reMaterialize.ts`), which re-derives the
 * space from the event log into a fresh DB and swaps it in.
 *
 *   1. `up` (worker thread) — structural DDL applied synchronously when a space
 *      DB is opened. An ALTER whose column is absent on a pre-vN DB needs one;
 *      `create table if not exists` does not, because `schema-space.sql` is
 *      exec'd idempotently on every open.
 *
 *   2. `runPendingSpaceMigrations` (main thread) — async data tasks, one per
 *      `kind: "data"` version, registered in `spaceMigrations.ts`. These may
 *      read the event log, which a worker-thread migration cannot. Every
 *      `kind: "data"` version MUST register a task there; a `kind:
 *      "structural"` version MUST NOT. Both directions are compiler-enforced
 *      via `SpaceAsyncVersion` below.
 *
 * This module is imported by BOTH the worker thread and the main thread, so it
 * MUST stay dependency-free: no `log.ts` (which pulls in OpenTelemetry), no
 * `db.ts`. Types and constants only.
 */
import type { Database } from "bun:sqlite";

/**
 * One per-space schema version. `up` is the optional structural DDL the worker
 * applies when advancing onto this version; `kind` decides whether the boot
 * runner must have an async data task registered.
 */
export type SpaceMigrationEntry =
  | {
      /** No async work: the worker applies `up` (if any) and advances the row. */
      kind: "structural";
      up?: (db: Database) => void;
    }
  | {
      /** Async data migration whose function is registered in the task map. */
      kind: "data";
      up?: (db: Database) => void;
    };

/**
 * Every per-space schema version, in order. `SPACE_SCHEMA_VERSION` is the
 * highest key, so adding a version here is the single edit that drives the
 * worker's upgrade loop, the fresh-DB stamp, and the task-map key type.
 *
 * `schema-space.sql` is exec'd on every open regardless of version and creates
 * every current table, so a structural version needs an `up` only for an ALTER
 * that `create table if not exists` cannot express.
 */
export const SPACE_MIGRATIONS = {
  // v1–v2 predate this manifest: v1 is the initial per-space split, v2 added a
  // full-text search index that no longer exists. Their DDL lives in
  // schema-space.sql, so neither carries an `up`.
  "1": { kind: "structural" },
  "2": { kind: "structural" },
  // Deterministic ordering keys. `entities.sort_idx` is `time + log position`,
  // where the time half is the log's server-observed receipt
  // (`stream_events.received_at`, falling back to `created_at` and then the
  // sender-minted ULID time) instead of the sender's clock. The task recomputes
  // every message's key from the log and re-anchors the read-state watermarks
  // that stored the old ones; the alternative is replaying every space.
  "3": { kind: "data" },
  // Next per-space schema change goes here, e.g.:
  //   "4": { kind: "structural", up(db) { /* alter table … */ } },
  //   "4": { kind: "data" },          // plus a task in SPACE_MIGRATION_TASKS
} as const satisfies Record<string, SpaceMigrationEntry>;

/**
 * The versions whose `kind` is `"data"` — exactly the keys the async task map
 * must cover. Derived, not hand-listed, so it cannot drift from the manifest.
 */
export type SpaceAsyncVersion = {
  [K in keyof typeof SPACE_MIGRATIONS]: (typeof SPACE_MIGRATIONS)[K] extends {
    kind: "data";
  }
    ? K
    : never;
}[keyof typeof SPACE_MIGRATIONS];

/**
 * The current per-space schema version — the highest version in the manifest.
 *
 * This is the version a freshly-created space DB is stamped with, and the
 * version a rebuild writes. A DB whose version is lower is upgraded in place
 * (worker `up`s, then the boot runner's data tasks); a DB whose version is not
 * a key of `SPACE_MIGRATIONS` cannot be upgraded and is rebuilt.
 */
export const SPACE_SCHEMA_VERSION = String(
  Math.max(...Object.keys(SPACE_MIGRATIONS).map((v) => Number(v))),
);

/** Every manifest version, numerically ascending — the upgrade order. */
export const SPACE_VERSION_KEYS = Object.keys(SPACE_MIGRATIONS).sort(
  (a, b) => Number(a) - Number(b),
);

/**
 * The manifest entry for `version`, or undefined if the version is unknown.
 * Returns the entry (not the raw literal) so `kind` narrows at the call site.
 */
export function spaceMigrationEntry(
  version: string,
): SpaceMigrationEntry | undefined {
  return (SPACE_MIGRATIONS as Record<string, SpaceMigrationEntry>)[version];
}
