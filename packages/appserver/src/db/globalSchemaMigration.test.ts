/**
 * Regression coverage for additive global schema upgrades.
 *
 * A v4→v5 bump previously deleted global.sqlite. Per-space cursors remained
 * current, so startup replay skipped every stream and getSpaces stayed empty.
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

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const GLOBAL_SCHEMA_PATH = join(THIS_DIR, "schema-global.sql");
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
        .get<{ completed_at: number | null }>(GLOBAL_SCHEMA_VERSION);

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
    // Simulate an interrupted v8 deployment: the version-8 pending marker was
    // registered at that deployment's init but its task never completed, so
    // runPendingGlobalMigrations must still replay the rebuild before the v9
    // task (this mirrors how a production DB upgrading 7 → 9 looks).
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
      expect(version?.version).toBe("9");

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
