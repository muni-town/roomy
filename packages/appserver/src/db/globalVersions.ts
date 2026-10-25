/**
 * Single source of truth for the global DB schema version and its migrations.
 *
 * Global DB upgrades are additive and migrate in place (`GLOBAL_SCHEMA_VERSION`
 * is documented in db.ts — never wipe global.sqlite on a bump). Two mechanisms
 * advance a version, exactly as for read-state:
 *
 *   1. `up` (worker thread) — structural DDL applied synchronously at worker
 *      init. Nearly always unnecessary: `schema-global.sql` is exec'd
 *      idempotently on every open, so `create table if not exists` is already
 *      present on both fresh and existing DBs. Only an ALTER whose column is
 *      absent on a pre-vN DB needs an explicit `up`.
 *
 *   2. `runPendingGlobalMigrations` (main thread) — async data tasks that may
 *      fan out across per-space DBs. A `kind: "data"` version MUST register a
 *      task in `GLOBAL_MIGRATION_TASKS` (globalMigrations.ts); a
 *      `kind: "structural"` version MUST NOT. Both directions are enforced by
 *      the compiler via `GlobalAsyncVersion` below.
 *
 * This module is imported by BOTH the worker thread and the main thread, so it
 * MUST stay dependency-free: no `log.ts` (which pulls in OpenTelemetry), no
 * `db.ts`. Types and constants only.
 */
import type { Database } from "bun:sqlite";

/**
 * One global schema version. `up` is the optional structural DDL the worker
 * applies when advancing onto this version; `kind` decides whether the boot
 * runner must have an async data task registered.
 */
export type GlobalMigrationEntry =
  | {
      /** No async work: the worker applies `up` (if any) and boot stamps the marker. */
      kind: "structural";
      up?: (db: Database) => void;
    }
  | {
      /** Async data migration whose function is registered in the task map. */
      kind: "data";
      up?: (db: Database) => void;
    };

/**
 * Every global schema version, in order. `GLOBAL_SCHEMA_VERSION` is the highest
 * key. Versions <= 9 carry no structural `up`: their DDL lives in
 * `schema-global.sql` (applied idempotently on every open) and their async
 * tasks in `GLOBAL_MIGRATION_TASKS`. Version 10 is the first driven end-to-end
 * from this manifest.
 */
export const GLOBAL_MIGRATIONS = {
  "2": { kind: "structural" },
  "3": { kind: "structural" },
  // pending_links / mentions / mentions.kind tables all live in
  // schema-global.sql; the v4–v6 rows predate async-task tracking and v6's
  // repair task is registered in GLOBAL_MIGRATION_TASKS.
  "4": { kind: "structural" },
  "5": { kind: "structural" },
  "6": { kind: "data" },
  "7": { kind: "structural" },
  // federation_receiver_permissions.kind widened to admit 'members' — the table
  // is rebuilt by the async task (SQLite cannot ALTER a CHECK constraint).
  "8": { kind: "data" },
  // mentions.kind added and backfilled by the async task.
  "9": { kind: "data" },
  // space_stats aggregate for the admin dashboard's space list. Structural:
  // schema-global.sql creates the table on every open. Its rows are published
  // by the boot per-space sweep in reMaterializeFromLocalEvents (which runs
  // for every boot and every stream, so an existing dataset self-heals) — a
  // data migration here would duplicate that sweep.
  "10": { kind: "structural" },
  // search_backfill_space, the backfill sweeper's candidate list. Structural:
  // schema-global.sql creates the table and the entity_space trigger that
  // populates it on every open. The async task seeds the rows of an existing
  // DB, whose entity_space rows predate the trigger.
  "11": { kind: "data" },
  // link_embeds, the enriched link metadata store. Structural: schema-global.sql
  // creates the table on every open. Its rows are copied in by the v5 per-space
  // migration (which runs over each space before dropping the per-space table
  // it replaces), so there is no global-side task.
  "12": { kind: "structural" },
  // worker_leases generalises voice_reconciler_lease: the same row shape, one
  // row per background loop rather than one table for the voice reconciler.
  // schema-global.sql creates it on every open; the `up` carries any live
  // claim across and drops the table it replaces.
  "13": {
    kind: "structural",
    up: (db) => {
      const legacy = db
        .query(
          "select name from sqlite_master where type = 'table' and name = 'voice_reconciler_lease'",
        )
        .get();
      if (!legacy) return;
      db.exec(
        `insert or ignore into worker_leases (name, holder, expires_at, updated_at)
         select name, holder, expires_at, updated_at from voice_reconciler_lease;
         drop table voice_reconciler_lease;`,
      );
    },
  },
  // worker_leases.epoch: the fencing epoch the space workers take with a lease
  // and stamp on every batch. schema-global.sql declares the column for fresh
  // DBs, but `create table if not exists` is a no-op on the table an existing
  // DB already has, so the column needs this ALTER. The worker that takes
  // leases adds the column itself when it finds it absent, so the check keeps
  // this idempotent regardless of which runtime opened the file first.
  "14": {
    kind: "structural",
    up: (db) => {
      const hasEpoch = db
        .query(
          "select count(*) as n from pragma_table_info('worker_leases') where name = 'epoch'",
        )
        .get() as { n: number } | null;
      if ((hasEpoch?.n ?? 0) > 0) return;
      db.exec(
        "alter table worker_leases add column epoch integer not null default 1",
      );
    },
  },
  // Next global schema change goes here, e.g.:
  //   "15": { kind: "structural" },   // table added to schema-global.sql
  //   "15": { kind: "data" },         // plus a task in GLOBAL_MIGRATION_TASKS
} as const satisfies Record<string, GlobalMigrationEntry>;

/**
 * The versions whose `kind` is `"data"` — exactly the keys the async task map
 * must cover. Derived, not hand-listed, so it cannot drift from the manifest.
 */
export type GlobalAsyncVersion = {
  [K in keyof typeof GLOBAL_MIGRATIONS]: (typeof GLOBAL_MIGRATIONS)[K] extends {
    kind: "data";
  }
    ? K
    : never;
}[keyof typeof GLOBAL_MIGRATIONS];

/** The current global schema version — the highest version in the manifest. */
export const GLOBAL_SCHEMA_VERSION = String(
  Math.max(...Object.keys(GLOBAL_MIGRATIONS).map((v) => Number(v))),
);

/**
 * The manifest entry for `version`, or undefined if the version is unknown.
 * Returns the entry (not the raw literal) so `kind` narrows at the call site.
 */
export function globalMigrationEntry(
  version: string,
): GlobalMigrationEntry | undefined {
  return (GLOBAL_MIGRATIONS as Record<string, GlobalMigrationEntry>)[version];
}
