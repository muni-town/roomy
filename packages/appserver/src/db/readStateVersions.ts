/**
 * Single source of truth for the read-state schema version and its migrations.
 *
 * The read-state DB (`data/roomy-readstate.sqlite`) is versioned by one number
 * and upgraded by two mechanisms:
 *
 *   1. `up` (worker thread) — structural DDL applied synchronously at worker
 *      init, before `handleInit` returns. Most versions need none:
 *      `readStateSchema.sql` is exec'd idempotently on every open, so a plain
 *      `create table if not exists` is already present on both fresh and
 *      existing DBs. Only an ALTER whose column is absent on a pre-vN DB needs
 *      an explicit `up` — declaring the column at the top level of the schema
 *      file would throw on that DB before the migration can run. (See the NOTE
 *      in `readStateSchema.sql` for the v7 instance of this.)
 *
 *   2. `runPendingReadStateMigrations` (main thread) — async data tasks that
 *      may scan the event log. Every `kind: "data"` version MUST register a
 *      task in `READSTATE_MIGRATION_TASKS` (userSpaceMembershipMigration.ts);
 *      a `kind: "structural"` version MUST NOT. Both directions are enforced
 *      by the compiler — `ReadStateAsyncVersion` below is derived from this
 *      manifest, and the task map is typed as `Record<ReadStateAsyncVersion,
 *      …>`, so a missing task and a task for a structural version are both
 *      type errors rather than a boot-time crash loop.
 *
 * This module is imported by BOTH the worker thread and the main thread, so it
 * MUST stay dependency-free: no `log.ts` (which pulls in OpenTelemetry), no
 * `db.ts`. Types and constants only.
 */
import type { Database } from "bun:sqlite";

/**
 * One read-state schema version. `up` is the optional structural DDL the
 * worker applies when advancing onto this version; `kind` decides whether the
 * boot runner must have an async data task registered.
 */
export type ReadStateMigrationEntry =
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
 * Every read-state schema version, in order. `READSTATE_SCHEMA_VERSION` is the
 * highest key, so bumping a version here is the single edit that drives the
 * worker's upgrade loop, the fresh-DB stamp, and the task-map key type.
 */
export const READSTATE_MIGRATIONS = {
  // user_thread_activity + its per-user index. Both are in readStateSchema.sql,
  // which is exec'd on any DB reaching this version.
  "2": { kind: "structural" },
  // Web push tables (subscriptions, defaults, preferences, participation,
  // digest state) — all in readStateSchema.sql.
  "3": { kind: "structural" },
  // Feature flags + assignments — in readStateSchema.sql.
  "4": { kind: "structural" },
  // read_positions.space_did. An ALTER that cannot be expressed as
  // `create table if not exists`, and the column is absent on pre-v5 DBs.
  "5": {
    kind: "structural",
    up(db: Database) {
      const cols = db
        .query<{ name: string }, []>(
          "select name from pragma_table_info('read_positions')",
        )
        .all()
        .map((r) => r.name);
      if (!cols.includes("space_did")) {
        db.exec(
          "alter table read_positions add column space_did text not null default ''",
        );
      }
    },
  },
  // Durable user-space membership intent. The table is in readStateSchema.sql;
  // the async task is the event-log recovery scan.
  "6": { kind: "data" },
  // user_thread_activity.space_did + the per-space index. Both are deliberately
  // NOT in readStateSchema.sql — the index references a column that does not
  // exist on a pre-v7 DB — so the worker adds them here. The async task
  // backfills the column from the global entity_space index.
  "7": {
    kind: "data",
    up(db: Database) {
      const cols = db
        .query<{ name: string }, []>(
          "select name from pragma_table_info('user_thread_activity')",
        )
        .all()
        .map((r) => r.name);
      if (!cols.includes("space_did")) {
        db.exec(
          "alter table user_thread_activity add column space_did text not null default ''",
        );
      }
      db.exec(`
        create index if not exists idx_user_thread_activity_user_space
          on user_thread_activity(user_did, space_did, last_active_at desc)
      `);
    },
  },
  // Per-user space ordering — space_order + index in readStateSchema.sql.
  "8": { kind: "structural" },
  // Roomy Pro bridge tokens — bridge_token_grants + index in readStateSchema.sql.
  "9": { kind: "structural" },
  // Roomy Pro members-area role grants — pro_role_grants in readStateSchema.sql.
  "10": { kind: "structural" },
  // Per-user OAuth scope grants — user_oauth_grants in readStateSchema.sql.
  "11": { kind: "structural" },
} as const satisfies Record<string, ReadStateMigrationEntry>;

/**
 * The versions whose `kind` is `"data"` — exactly the keys the async task map
 * must cover. Derived, not hand-listed, so it cannot drift from the manifest.
 */
export type ReadStateAsyncVersion = {
  [K in keyof typeof READSTATE_MIGRATIONS]: (typeof READSTATE_MIGRATIONS)[K] extends {
    kind: "data";
  }
    ? K
    : never;
}[keyof typeof READSTATE_MIGRATIONS];

/** The current read-state schema version — the highest version in the manifest. */
export const READSTATE_SCHEMA_VERSION = String(
  Math.max(...Object.keys(READSTATE_MIGRATIONS).map((v) => Number(v))),
);

/**
 * The manifest entry for `version`, or undefined if the version is unknown.
 * Returns the entry (not the raw literal) so `kind` narrows at the call site.
 */
export function readStateMigrationEntry(
  version: string,
): ReadStateMigrationEntry | undefined {
  return (READSTATE_MIGRATIONS as Record<string, ReadStateMigrationEntry>)[
    version
  ];
}
