/**
 * SQLite handle for the appserver's read-state database.
 *
 * Separate from the materialisation DB because read_positions is
 * appserver-owned state that cannot be reconstructed from the Leaf event
 * log. The materialisation DB can be wiped and re-backfilled; this one
 * must survive across schema changes and server restarts.
 *
 * At startup the read-state DB is ATTACHed to the materialisation DB as
 * `readstate`, so SQL in materialisers and handlers can reference
 * `readstate.read_positions` for cross-database joins.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Bump whenever readStateSchema.sql changes.
 * Uses a separate versioning namespace from the materialisation DB.
 */
export const READSTATE_SCHEMA_VERSION = "3";

const DEFAULT_DB_PATH =
  process.env.READSTATE_DB_PATH ?? "data/roomy-readstate.sqlite";

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "readStateSchema.sql",
);

let dbInstance: Database | null = null;

export interface OpenReadStateDbOpts {
  /** Filesystem path or `:memory:`. Defaults to `READSTATE_DB_PATH` or `data/roomy-readstate.sqlite`. */
  path?: string;
  /** If true, skip the process-wide singleton (useful for tests). */
  isolated?: boolean;
}

/**
 * Open (or return) the read-state SQLite database, applying the schema
 * and verifying the version row.
 */
export function openReadStateDb(opts: OpenReadStateDbOpts = {}): Database {
  if (!opts.isolated && dbInstance) return dbInstance;

  const path = opts.path ?? DEFAULT_DB_PATH;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });

  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");

  initializeReadStateSchema(db);

  if (!opts.isolated) dbInstance = db;
  return db;
}

/**
 * A single read-state schema migration.
 * Each migration applies DDL/DML needed to reach the next schema version.
 * Migrations must be idempotent (use IF NOT EXISTS / IF EXISTS) so that
 * re-applying the same migration is safe (though in practice each runs
 * inside its own transaction, so a crash mid-migration rolls back entirely).
 *
 * Adding a migration:
 *   1. Bump `READSTATE_SCHEMA_VERSION`
 *   2. Update `readStateSchema.sql` to reflect the final desired schema
 *   3. Append a `Migration` entry to the `MIGRATIONS` array
 */
interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    up: () => {
      // Schema v1 is the base — created by readStateSchema.sql directly.
      // This entry exists so the migration machinery accounts for it.
    },
  },
  {
    version: 2,
    name: "user_thread_activity",
    up: (db) => {
      db.exec(`
        create table if not exists user_thread_activity (
          user_did      text not null,
          thread_id     text not null,
          last_active_at integer not null,
          updated_at    integer not null default (unixepoch() * 1000),
          primary key (user_did, thread_id)
        ) strict;

        create index if not exists idx_user_thread_activity_user
          on user_thread_activity(user_did, last_active_at desc);
      `);
    },
  },
  {
    version: 3,
    name: "web_push",
    up: (db) => {
      // Web push plumbing: subscriptions, preferences, and the digest
      // state tables. The schema.sql already creates these (idempotent), so
      // a fresh DB needs no migration work; this entry exists so existing
      // v2 databases migrate cleanly and record v3. All DDL uses IF NOT
      // EXISTS, making it safe to re-apply.
      db.exec(`
        create table if not exists push_subscriptions (
          user_did        text not null,
          endpoint        text not null,
          p256dh          text not null,
          auth            text not null,
          expiration_time integer,
          created_at      integer not null default (unixepoch() * 1000),
          updated_at      integer not null default (unixepoch() * 1000),
          primary key (user_did, endpoint)
        ) strict;
        create index if not exists idx_push_subs_user
          on push_subscriptions(user_did);

        create table if not exists push_user_default (
          user_did text primary key,
          level    text not null check(level in ('silent','quiet','engaged','busy')) default 'engaged',
          updated_at integer not null default (unixepoch() * 1000)
        ) strict;

        create table if not exists push_preferences (
          user_did  text not null,
          space_id  text not null,
          level     text not null check(level in ('silent','quiet','engaged','busy')),
          updated_at integer not null default (unixepoch() * 1000),
          primary key (user_did, space_id)
        ) strict;

        create table if not exists user_room_participation (
          user_did         text not null,
          room_id          text not null,
          last_message_at  integer not null,
          updated_at       integer not null default (unixepoch() * 1000),
          primary key (user_did, room_id)
        ) strict;
        create index if not exists idx_user_room_participation_user
          on user_room_participation(user_did, last_message_at desc);

        create table if not exists notification_state (
          user_did            text not null,
          room_id             text not null,
          first_unseen_at     integer,
          first_unseen_msg_id text,
          unseen_count        integer not null default 0,
          notified            integer not null default 0 check(notified in (0,1)),
          pushed_at           integer,
          updated_at          integer not null default (unixepoch() * 1000),
          primary key (user_did, room_id)
        ) strict;
        create index if not exists idx_notification_state_due
          on notification_state(notified, first_unseen_at);
      `);
    },
  },
];

/**
 * Apply readStateSchema.sql and run any pending migrations.
 *
 * Unlike the materialisation DB (which throws on version mismatch and
 * expects a wipe + re-backfill), the read-state DB runs migrations.
 * The schema.sql is always applied fresh (it uses CREATE IF NOT EXISTS),
 * then any pending migrations run in order to bring the on-disk
 * version up to READSTATE_SCHEMA_VERSION.
 */
export function initializeReadStateSchema(db: Database): void {
  // Always apply the full schema (idempotent via IF NOT EXISTS).
  // This ensures a fresh DB has the latest schema directly, without
  // needing to run every migration sequentially.
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);

  // Determine current on-disk version. The schema_version table stores
  // version as text; max() works lexicographically, which is safe because
  // versions are monotonically increasing positive integers.
  const currentVersionRow = db
    .query<
      { v: string | null },
      []
    >("select max(version) as v from readstate_schema_version")
    .get();
  const currentVersion = Number(currentVersionRow?.v ?? 0);

  // Run pending migrations in order.
  // Each migration runs inside its own transaction so a crash mid-migration
  // rolls back cleanly without leaving the DB in a partial state.
  const upsertVersion = db.prepare(
    "insert or replace into readstate_schema_version (id, version) values (1, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    db.transaction(() => {
      migration.up(db);
      upsertVersion.run(migration.version);
    })();
  }

  // Verify the final version matches expected (sanity check).
  const finalVersionRow = db
    .query<
      { v: string | null },
      []
    >("select max(version) as v from readstate_schema_version")
    .get();
  const finalVersion = Number(finalVersionRow?.v ?? 0);

  if (finalVersion !== Number(READSTATE_SCHEMA_VERSION)) {
    throw new Error(
      `Read-state schema version mismatch: on disk = ${finalVersion}, ` +
        `expected = ${READSTATE_SCHEMA_VERSION}. ` +
        `If this is a fresh start after a downgrade, delete or reset ` +
        `the read-state database at ${db.path}.`,
    );
  }
}

/**
 * ATTACH the read-state database to a materialisation DB connection.
 * After this, SQL on the materialisation DB can reference
 * `readstate.read_positions` for cross-database operations.
 */
export function attachReadState(mainDb: Database, readStateDb: Database): void {
  const row = readStateDb
    .query<{ file: string }, []>("pragma database_list")
    .all()
    .find((r) => r.file !== "");
  const path = row?.file;
  if (!path) {
    throw new Error(
      "Cannot ATTACH an in-memory read-state DB. Use attachInMemoryReadState() for tests.",
    );
  }
  mainDb.exec(`attach database '${path}' as readstate`);
}

/**
 * Convenience for tests: create the readstate schema directly in the
 * materialisation DB as the `readstate` attached schema.
 *
 * In-memory databases cannot be ATTACHed to each other, so for tests we
 * create a file-backed temporary DB instead.
 */
export function attachInMemoryReadState(mainDb: Database): Database {
  const tmpDir = mkdtempSync(join(realpathSync(tmpdir()), "roomy-readstate-"));
  const dbPath = join(tmpDir, "readstate.sqlite");
  const readStateDb = openReadStateDb({ path: dbPath, isolated: true });
  mainDb.exec(`attach database '${dbPath}' as readstate`);
  return readStateDb;
}

/** Close + clear the singleton. Tests only. */
export function closeReadStateDb(): void {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
}
