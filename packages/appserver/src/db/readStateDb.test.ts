import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabasePool } from "./pool.ts";
import { GLOBAL_SCHEMA_VERSION, SPACE_SCHEMA_VERSION } from "./db.ts";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";
import {
  READSTATE_MIGRATIONS,
  readStateMigrationEntry,
} from "./readStateVersions.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(THIS_DIR, "readStateSchema.sql");
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("read-state schema", () => {
  test("READSTATE_SCHEMA_VERSION is exported", () => {
    expect(READSTATE_SCHEMA_VERSION).toBe("11");
  });

  test("schema applies cleanly on a fresh database", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");

    // Apply the schema directly (same as what the worker does).
    const { readFileSync } = require("node:fs");
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "readStateSchema.sql",
    );
    db.exec(readFileSync(schemaPath, "utf8"));

    // Write the version row.
    db.run(
      "insert or replace into readstate_schema_version (id, version) values (1, ?)",
      [READSTATE_SCHEMA_VERSION],
    );

    const version = db
      .query<
        { version: string },
        []
      >("select version from readstate_schema_version where id = 1")
      .get();
    expect(version?.version).toBe(READSTATE_SCHEMA_VERSION);

    const tables = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((r) => r.name);

    expect(tables).toContain("read_positions");
    expect(tables).toContain("user_oauth_grants");
    expect(tables).toContain("user_thread_activity");
  });

  /**
   * Progressive scope expansion (Phase 1): `user_oauth_grants` arrives as
   * schema v11 — a purely structural bump (the table is a plain
   * `create table if not exists` in readStateSchema.sql, so no `up` and no
   * async task). A DB stamped at the previous version must reach v11 on open
   * and carry the table.
   */
  test("upgrades a v10 database to v11 and gains user_oauth_grants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomy-readstate-scope-"));
    cleanup.push(dir);
    const path = join(dir, "roomy-readstate.sqlite");
    const old = new Database(path, { create: true });
    old.exec(readFileSync(SCHEMA_PATH, "utf8"));
    // Simulate a deployed pre-v11 DB: the table does not exist yet.
    old.exec("drop table if exists user_oauth_grants");
    old.run("update readstate_schema_version set version = '10' where id = 1");
    old.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: path,
        eventsDbPath: ":memory:",
        spacesDir: ":memory:",
        globalDbPath: ":memory:",
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });
      const readState = pool.readState();

      const version = await readState
        .query("select version from readstate_schema_version where id = 1")
        .get<{ version: string }>();
      expect(version?.version).toBe("11");

      const tables = await readState
        .query("select name from sqlite_master where type = 'table' order by name")
        .all<{ name: string }>();
      expect(tables.map((t) => t.name)).toContain("user_oauth_grants");

      // The table is usable: its PK + columns match the store's statements.
      await readState.run(
        "insert into user_oauth_grants (user_did, granted_scope) values (?, ?)",
        ["did:plc:migrated-user", "atproto"],
      );
      const row = await readState
        .query("select granted_scope from user_oauth_grants where user_did = ?")
        .get<{ granted_scope: string }>("did:plc:migrated-user");
      expect(row?.granted_scope).toBe("atproto");
    } finally {
      pool.close();
    }
  });

  test("structural v11 bump registers no async migration marker", () => {
    const entry = readStateMigrationEntry("11");
    expect(entry?.kind).toBe("structural");
    expect(entry?.up).toBeUndefined();
  });

  test("schema file does not throw on a pre-v7 DB (space_did index is migration-only)", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");

    // Simulate a v6 DB: user_thread_activity WITHOUT space_did, version row = 6.
    db.exec(`
      create table user_thread_activity (
        user_did      text not null,
        thread_id     text not null,
        last_active_at integer not null,
        updated_at    integer not null default (unixepoch() * 1000),
        primary key (user_did, thread_id)
      ) strict
    `);
    db.exec(`
      create table readstate_schema_version (
        id integer primary key check (id = 1),
        version text not null
      ) strict
    `);
    db.exec("insert into readstate_schema_version (id, version) values (1, '6')");

    // Applying the current schema file must NOT throw (the per-space index is
    // not in the file — it is created by the v7 migration / fresh-DB path).
    const { readFileSync } = require("node:fs");
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "readStateSchema.sql",
    );
    expect(() => db.exec(readFileSync(schemaPath, "utf8"))).not.toThrow();

    // The v7 migration adds the column + index.
    const cols = db
      .query<{ name: string }, []>(
        "select name from pragma_table_info('user_thread_activity')",
      )
      .all()
      .map((r) => r.name);
    if (!cols.includes("space_did")) {
      db.exec("alter table user_thread_activity add column space_did text not null default ''");
    }
    db.exec(`
      create index if not exists idx_user_thread_activity_user_space
        on user_thread_activity(user_did, space_did, last_active_at desc)
    `);

    const colsAfter = db
      .query<{ name: string }, []>(
        "select name from pragma_table_info('user_thread_activity')",
      )
      .all()
      .map((r) => r.name);
    expect(colsAfter).toContain("space_did");

    // The per-space query now works.
    db.exec("insert into user_thread_activity (user_did, thread_id, space_did, last_active_at) values ('u','t','s',1)");
    const rows = db
      .query<{ thread_id: string }, [string, string]>(
        "select thread_id from user_thread_activity where user_did = ? and space_did = ?",
      )
      .all("u", "s");
    expect(rows).toHaveLength(1);
  });

  test("migration runs from v1 schema to current version", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");

    // Apply v1 schema directly.
    db.exec(`
      create table if not exists readstate_schema_version (
        id integer primary key check (id = 1),
        version text not null
      ) strict;
      insert into readstate_schema_version (id, version) values (1, '1');

      create table if not exists read_positions (
        user_did    text not null,
        room_id     text not null,
        seen_up_to  text not null,
        unread_count integer not null default 0,
        updated_at  integer not null default (unixepoch() * 1000),
        primary key (user_did, room_id)
      ) strict;
    `);

    // Apply the full schema (same as worker's initializeReadStateSchema).
    const { readFileSync } = require("node:fs");
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "readStateSchema.sql",
    );
    db.exec(readFileSync(schemaPath, "utf8"));

    // Run migration: detect v1, apply all migrations up to current version.
    const currentVersionRow = db
      .query<{ v: string | null }, []>(
        "select max(version) as v from readstate_schema_version",
      )
      .get();
    const currentVersion = Number(currentVersionRow?.v ?? 0);
    const expectedNum = Number(READSTATE_SCHEMA_VERSION);

    if (currentVersion < expectedNum) {
      const upsertVersion = db.prepare(
        "update readstate_schema_version set version = ? where id = 1",
      );
      // Walk the real manifest (no hand-copied replica to drift): apply each
      // version's structural `up`, in order, up to the current version — the
      // same traversal the DB worker performs at init.
      const ordered = Object.keys(READSTATE_MIGRATIONS).sort(
        (a, b) => Number(a) - Number(b),
      );
      for (const key of ordered) {
        const num = Number(key);
        if (num <= currentVersion || num > expectedNum) continue;
        const entry = readStateMigrationEntry(key);
        db.transaction(() => {
          entry?.up?.(db);
          upsertVersion.run(key);
        })();
      }
    }

    // Version should be at current.
    const version = db
      .query<
        { version: string },
        []
      >("select version from readstate_schema_version where id = 1")
      .get();
    expect(version?.version).toBe(READSTATE_SCHEMA_VERSION);

    // Thread activity table should now exist.
    const tables = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("user_thread_activity");
  });

  test("worker schedules markers only for data versions when upgrading in place", async () => {
    // The worker owns the upgrade: it walks the manifest, applies each
    // version's structural `up`, and inserts a pending `readstate_schema_migrations`
    // row ONLY for `kind: "data"` versions. A DB seeded at v2 must therefore
    // come out stamped current with markers for exactly the data versions —
    // this is what stops a structural bump from needing a hand-written no-op
    // task (the v8/v9/v10 crash-loop class).
    const dir = mkdtempSync(join(tmpdir(), "roomy-readstate-upgrade-"));
    cleanup.push(dir);
    const path = join(dir, "roomy-readstate.sqlite");
    const old = new Database(path, { create: true });
    old.exec(readFileSync(SCHEMA_PATH, "utf8"));
    old.run("insert into readstate_schema_version (id, version) values (1, '2')");
    old.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: path,
        eventsDbPath: ":memory:",
        spacesDir: ":memory:",
        globalDbPath: ":memory:",
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });
      const readState = pool.readState();
      const version = await readState
        .query("select version from readstate_schema_version where id = 1")
        .get<{ version: string }>();
      expect(version?.version).toBe(READSTATE_SCHEMA_VERSION);

      const markers = await readState
        .query("select version from readstate_schema_migrations order by cast(version as integer)")
        .all<{ version: string }>();
      const dataVersions = Object.keys(READSTATE_MIGRATIONS).filter(
        (v) => readStateMigrationEntry(v)?.kind === "data",
      );
      expect(markers.map((m) => m.version)).toEqual(dataVersions);
    } finally {
      pool.close();
    }
  });

  test("migration is idempotent on already-migrated db", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");

    // Apply the full schema.
    const { readFileSync } = require("node:fs");
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "readStateSchema.sql",
    );
    db.exec(readFileSync(schemaPath, "utf8"));
    db.run(
      "insert or replace into readstate_schema_version (id, version) values (1, ?)",
      [READSTATE_SCHEMA_VERSION],
    );

    // Re-apply — should not throw.
    db.exec(readFileSync(schemaPath, "utf8"));

    // Version still at current.
    const version = db
      .query<
        { version: string },
        []
      >("select version from readstate_schema_version where id = 1")
      .get();
    expect(version?.version).toBe(READSTATE_SCHEMA_VERSION);
  });

  /**
   * Regression: the read-state write path filters
   * `read_positions` by `room_id` alone — the createMessage unread bump and
   * its `getRoomReadPositionUsers` read, plus the delete/move unwind's
   * `where room_id = ? and unread_count > 0`. The primary key is
   * `(user_did, room_id)`, which cannot serve a `room_id`-only filter, so
   * without an explicit index every one of those queries scans the whole
   * table — global across all spaces. On a large table that is seconds per
   * scan inside `sendEvents`.
   *
   * Asserts the plan, not just index presence: an index that SQLite declines
   * to use would leave the scan in place.
   */
  test("read_positions has an index that serves room_id-only lookups", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));

    // Every read-state query the write path issues, filtered by room_id alone.
    const roomScopedQueries = [
      "select user_did from read_positions where room_id = ?",
      "select user_did, seen_up_to, unread_count from read_positions where room_id = ? and unread_count > 0",
      "update read_positions set unread_count = unread_count + 1 where room_id = ?",
    ];
    for (const sql of roomScopedQueries) {
      const plan = db
        .query<{ detail: string }, []>(`explain query plan ${sql}`)
        .all()
        .map((r) => r.detail)
        .join(" | ");
      // A bare SCAN of read_positions is the regression: it reads every row
      // in a table that is global across all spaces.
      expect(plan).not.toMatch(/\bSCAN read_positions\b/);
      expect(plan).toMatch(/idx_read_positions_room|SEARCH read_positions/);
    }
  });

  /**
   * The index must reach EXISTING databases: `initializeReadStateSchema`
   * execs the schema file on every open regardless of version, so a DB that
   * predates the index gains it at next boot.
   * Asserts that path explicitly, since a migration-only index (or one gated
   * behind a version bump) would leave deployed databases scanning.
   */
  test("room_id index is added to an already-current database on open", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    db.exec(`
      create table readstate_schema_version (
        id integer primary key check (id = 1),
        version text not null
      ) strict;
      insert into readstate_schema_version (id, version) values (1, '${READSTATE_SCHEMA_VERSION}');
      create table read_positions (
        user_did    text not null,
        room_id     text not null,
        space_did   text not null default '',
        seen_up_to  text not null,
        unread_count integer not null default 0,
        updated_at  integer not null default (unixepoch() * 1000),
        primary key (user_did, room_id)
      ) strict;
    `);

    const indexesBefore = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'index' and tbl_name = 'read_positions'",
      )
      .all()
      .map((r) => r.name);
    expect(indexesBefore).not.toContain("idx_read_positions_room");

    // What the worker does on every open, at any version.
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));

    const indexesAfter = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'index' and tbl_name = 'read_positions'",
      )
      .all()
      .map((r) => r.name);
    expect(indexesAfter).toContain("idx_read_positions_room");
    // No version bump was needed, so the stamp is untouched.
    expect(
      db
        .query<{ version: string }, []>(
          "select version from readstate_schema_version where id = 1",
        )
        .get()?.version,
    ).toBe(READSTATE_SCHEMA_VERSION);
  });
});
