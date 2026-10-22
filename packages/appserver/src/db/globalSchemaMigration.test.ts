/**
 * Regression coverage for additive global schema upgrades.
 *
 * A global schema bump must not delete global.sqlite: per-space cursors stay
 * current, so startup replay would skip every stream and getSpaces would stay
 * empty.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabasePool } from "./pool.ts";
import { GLOBAL_SCHEMA_VERSION, SPACE_SCHEMA_VERSION } from "./db.ts";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";
import { runPendingGlobalMigrations } from "./globalMigrations.ts";
import { GLOBAL_MIGRATIONS } from "./globalVersions.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const GLOBAL_SCHEMA_PATH = join(THIS_DIR, "schema-global.sql");

/**
 * The newest version that schedules async data work, i.e. the one that gets a
 * (null) marker row in `global_schema_migrations`. Only `kind: "data"`
 * versions are tracked there — a structural version's DDL is applied by the
 * schema exec, so it has no marker to assert on. Derived from the manifest so
 * adding a version cannot silently invalidate this.
 */
const NEWEST_DATA_VERSION = Object.entries(GLOBAL_MIGRATIONS)
  .filter(([, entry]) => entry.kind === "data")
  .map(([version]) => parseInt(version, 10))
  .sort((a, b) => b - a)[0]!
  .toString();
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("global schema migration", () => {
  test("upgrades an older schema in place without losing membership", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomy-global-schema-"));
    cleanup.push(dir);
    const globalPath = join(dir, "global.sqlite");
    const old = new Database(globalPath, { create: true });
    old.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
    old.exec("drop table mentions");
    old.run("insert into global_schema_version (id, version) values (1, '4')");
    old.run(
      "insert into edges (head, tail, label) values ('did:plc:user', 'did:plc:space', 'joinedSpace')",
    );
    old.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: ":memory:",
        eventsDbPath: ":memory:",
        globalDbPath: globalPath,
        spacesDir: join(dir, "spaces"),
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });

      const global = pool.global();
      const edge = await global
        .query("select 1 as n from edges where label = 'joinedSpace'")
        .get<{ n: number }>();
      const version = await global
        .query("select version from global_schema_version where id = 1")
        .get<{ version: string }>();
      const mentionsTable = await global
        .query(
          "select name from sqlite_master where type = 'table' and name = 'mentions'",
        )
        .get<{ name: string }>();
      const migration = await global
        .query(
          "select completed_at from global_schema_migrations where version = ?",
        )
        .get<{ completed_at: number | null }>(NEWEST_DATA_VERSION);

      expect(edge?.n).toBe(1);
      expect(version?.version).toBe(GLOBAL_SCHEMA_VERSION);
      expect(mentionsTable?.name).toBe("mentions");
      expect(migration?.completed_at).toBeNull();
    } finally {
      await pool.close();
    }
  });
});

describe("global schema v8 — receiver permission kind widening", () => {
  test("migration task rebuilds the table and preserves existing rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomy-global-schema-v8-"));
    cleanup.push(dir);
    const globalPath = join(dir, "global.sqlite");
    const old = new Database(globalPath, { create: true });
    old.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
    // Simulate a v7 DB: drop the members-capable table, recreate it with the
    // old ('user','role') CHECK, and seed a role + user grant.
    old.exec("drop table federation_receiver_permissions");
    old.exec(`create table federation_receiver_permissions (
      space_id text not null,
      federating_space_did text not null,
      room_id text not null,
      grantee text not null,
      kind text not null check(kind in ('user','role')),
      permission text not null check(permission in ('read','readwrite')),
      primary key (space_id, federating_space_did, room_id, grantee, kind)
    ) strict`);
    old.exec("insert into federation_receiver_permissions values ('did:web:a', 'did:web:b', '01ROOM', '01ROLE', 'role', 'readwrite')");
    old.exec("insert into federation_receiver_permissions values ('did:web:a', 'did:web:b', '01ROOM', 'did:plc:user', 'user', 'read')");
    old.run("insert into global_schema_version (id, version) values (1, '7')");
    // Simulate a DB left behind by an interrupted upgrade: the version-8
    // pending marker was registered at init but its task never completed, so
    // the global DB carries an uncompleted v8 marker while the table still has
    // the old constraint. Boot must run the missing v8 task, and the runner
    // must still replay the rebuild before the v9 task (a DB upgrading 7 → 9
    // in one step).
    old.run("insert into global_schema_migrations (version, completed_at) values ('8', null)");
    old.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: ":memory:",
        eventsDbPath: ":memory:",
        globalDbPath: globalPath,
        spacesDir: join(dir, "spaces"),
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });
      await runPendingGlobalMigrations(pool.router(), []);
      const global = pool.global();
      const version = await global
        .query("select version from global_schema_version where id = 1")
        .get<{ version: string }>();
      expect(version?.version).toBe(GLOBAL_SCHEMA_VERSION);

      // Existing grants survive the rebuild.
      const rows = await global
        .query(
          "select grantee, kind, permission from federation_receiver_permissions order by kind",
        )
        .all<{ grantee: string; kind: string; permission: string }>();
      expect(rows).toEqual([
        { grantee: "01ROLE", kind: "role", permission: "readwrite" },
        { grantee: "did:plc:user", kind: "user", permission: "read" },
      ]);

      // The widened CHECK now admits a 'members' grant.
      await global.run(
        "insert into federation_receiver_permissions values ('did:web:a', 'did:web:b', '01ROOM', 'did:web:b', 'members', 'read')",
      );
      const members = await global
        .query("select count(*) as n from federation_receiver_permissions where kind = 'members'")
        .get<{ n: number }>();
      expect(members?.n).toBe(1);
    } finally {
      await pool.close();
    }
  });

  test("migration task is a no-op on a fresh (current-schema) DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomy-global-schema-v8-fresh-"));
    cleanup.push(dir);
    const globalPath = join(dir, "global.sqlite");
    const fresh = new Database(globalPath, { create: true });
    fresh.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
    fresh.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: ":memory:",
        eventsDbPath: ":memory:",
        spacesDir: join(dir, "spaces"),
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });
      await runPendingGlobalMigrations(pool.router(), []);

      const global = pool.global();
      const table = await global
        .query(
          "select sql from sqlite_master where type = 'table' and name = 'federation_receiver_permissions'",
        )
        .get<{ sql: string }>();
      expect(table?.sql).toContain("'members'");
      expect(table?.sql).not.toContain("federation_receiver_permissions_v7");
    } finally {
      await pool.close();
    }
  });
});

describe("global schema v9 — mentions.kind column", () => {
  test("migration adds kind and backfills existing rows to 'mention'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomy-global-schema-v9-"));
    cleanup.push(dir);
    const globalPath = join(dir, "global.sqlite");
    const old = new Database(globalPath, { create: true });
    old.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
    // Simulate a v8 DB: the current schema already carries `kind`, so drop
    // the column from the mentions table to recreate the pre-v9 shape.
    old.exec("drop table mentions");
    old.exec(`create table mentions (
      did text not null,
      message_id text not null,
      space_did text not null,
      room_id text not null,
      created_at integer not null default (unixepoch() * 1000),
      primary key (did, message_id)
    ) strict`);
    old.exec("create index if not exists idx_mentions_did_created on mentions(did, created_at desc)");
    old.exec("insert into mentions (did, message_id, space_did, room_id, created_at) values ('did:plc:user', '01MSG1', 'did:web:space', '01ROOM', 1000)");
    old.exec("insert into mentions (did, message_id, space_did, room_id, created_at) values ('did:plc:user', '01MSG2', 'did:web:space', '01ROOM', 2000)");
    old.run("insert into global_schema_version (id, version) values (1, '8')");
    old.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: ":memory:",
        eventsDbPath: ":memory:",
        globalDbPath: globalPath,
        spacesDir: join(dir, "spaces"),
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });
      await runPendingGlobalMigrations(pool.router(), []);
      const global = pool.global();
      const version = await global
        .query("select version from global_schema_version where id = 1")
        .get<{ version: string }>();
      // Pinned to the running version rather than the literal "9": the worker
      // advances a v8 DB to GLOBAL_SCHEMA_VERSION, and this test is about
      // v9's `mentions.kind` backfill surviving that upgrade, not about which
      // version happens to be current.
      expect(version?.version).toBe(GLOBAL_SCHEMA_VERSION);

      // Existing rows survive and are backfilled to 'mention'.
      const rows = await global
        .query("select did, message_id, kind from mentions order by message_id")
        .all<{ did: string; message_id: string; kind: string }>();
      expect(rows).toEqual([
        { did: "did:plc:user", message_id: "01MSG1", kind: "mention" },
        { did: "did:plc:user", message_id: "01MSG2", kind: "mention" },
      ]);

      // The column now admits 'reply' rows.
      await global.run(
        "insert into mentions (did, message_id, space_did, room_id, kind, created_at) values ('did:plc:user', '01MSG3', 'did:web:space', '01ROOM', 'reply', 3000)",
      );
      const reply = await global
        .query("select kind from mentions where message_id = '01MSG3'")
        .get<{ kind: string }>();
      expect(reply?.kind).toBe("reply");
    } finally {
      await pool.close();
    }
  });

  test("migration task is a no-op on a fresh (current-schema) DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomy-global-schema-v9-fresh-"));
    cleanup.push(dir);
    const globalPath = join(dir, "global.sqlite");
    const fresh = new Database(globalPath, { create: true });
    fresh.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
    fresh.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: ":memory:",
        eventsDbPath: ":memory:",
        spacesDir: join(dir, "spaces"),
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });
      await runPendingGlobalMigrations(pool.router(), []);

      const global = pool.global();
      const table = await global
        .query(
          "select sql from sqlite_master where type = 'table' and name = 'mentions'",
        )
        .get<{ sql: string }>();
      expect(table?.sql).toContain("kind");
      expect(table?.sql).not.toContain("alter table mentions add column");
    } finally {
      await pool.close();
    }
  });
});

describe("mentions.message_id index", () => {
  test("an existing global DB gains the index at boot, with no version bump", async () => {
    // The index is additive DDL, not a migration: the worker re-execs the whole
    // schema file on every boot, so a DB stamped at the current version still
    // picks it up. Without that, the edit and delete paths would keep
    // full-scanning `mentions` on every deployed database.
    const dir = mkdtempSync(join(tmpdir(), "roomy-mentions-index-"));
    cleanup.push(dir);
    const globalPath = join(dir, "global.sqlite");
    const preIndex = new Database(globalPath, { create: true });
    preIndex.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
    preIndex.exec("drop index idx_mentions_message");
    preIndex.run("insert into global_schema_version (id, version) values (1, ?)", [
      GLOBAL_SCHEMA_VERSION,
    ]);
    preIndex.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: ":memory:",
        eventsDbPath: ":memory:",
        globalDbPath: globalPath,
        spacesDir: join(dir, "spaces"),
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });
      const global = pool.global();
      const index = await global
        .query("select name from sqlite_master where type = 'index' and name = 'idx_mentions_message'")
        .get<{ name: string }>();
      expect(index?.name).toBe("idx_mentions_message");

      // And the planner uses it for the statements that key on message_id.
      const plan = await global
        .query("explain query plan delete from mentions where message_id = ?")
        .all<{ detail: string }>("01MSG1");
      expect(plan.map((r) => r.detail).join(" | ")).toContain("idx_mentions_message");
    } finally {
      await pool.close();
    }
  });
});

describe("global schema v11 — search backfill candidate list", () => {
  test("an entity_space insert registers the space with the sweeper", () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));

    db.run(
      "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
      ["01ENTITY", "did:web:space.example"],
    );
    // Re-materialising an entity re-applies the same insert; the ignored
    // duplicate must leave the candidate list alone rather than raise.
    db.run(
      "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
      ["01ENTITY", "did:web:space.example"],
    );

    const candidates = db
      .query("select space_did from search_backfill_space")
      .all();
    expect(candidates).toEqual([{ space_did: "did:web:space.example" }]);
    db.close();
  });

  test("migration seeds spaces indexed before the trigger existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roomy-global-schema-v11-"));
    cleanup.push(dir);
    const globalPath = join(dir, "global.sqlite");
    const old = new Database(globalPath, { create: true });
    old.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
    // A pre-v11 DB: the index rows were written with no trigger to register
    // their spaces, so the sweeper has no candidate to pick.
    old.exec("drop trigger entity_space_search_backfill");
    old.run(
      "insert into entity_space (entity_id, space_did) values (?, ?)",
      ["01ENTITY", "did:web:space.example"],
    );
    old.run("insert into global_schema_version (id, version) values (1, '10')");
    old.close();

    const pool = new DatabasePool(1, join(THIS_DIR, "worker.ts"));
    try {
      await pool.init({
        readStateDbPath: ":memory:",
        eventsDbPath: ":memory:",
        globalDbPath: globalPath,
        spacesDir: join(dir, "spaces"),
        readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
        spaceSchemaVersion: SPACE_SCHEMA_VERSION,
        globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
      });
      await runPendingGlobalMigrations(pool.router(), []);

      const global = pool.global();
      const candidates = await global
        .query("select space_did from search_backfill_space")
        .all();
      expect(candidates).toEqual([{ space_did: "did:web:space.example" }]);

      // The trigger is back, so spaces materialised from here on register
      // themselves.
      await global.run(
        "insert into entity_space (entity_id, space_did) values (?, ?)",
        ["01ENTITY2", "did:web:second.example"],
      );
      const after = await global
        .query("select space_did from search_backfill_space order by space_did")
        .all();
      expect(after).toEqual([
        { space_did: "did:web:second.example" },
        { space_did: "did:web:space.example" },
      ]);
    } finally {
      await pool.close();
    }
  });
});
