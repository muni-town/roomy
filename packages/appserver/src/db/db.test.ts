import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPACE_SCHEMA_VERSION,
  GLOBAL_SCHEMA_VERSION,
  openDb,
} from "./db.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

function freshDb(schemaFile: string, versionTable: string, version: string): Database {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(join(THIS_DIR, schemaFile), "utf8");
  db.exec(schemaSql);
  db.run(`insert into ${versionTable} (id, version) values (1, ?)`, [version]);
  return db;
}

describe("per-space schema", () => {
  test("applies cleanly on a fresh database and writes the version row", () => {
    const db = freshDb("schema-space.sql", "space_schema_version", SPACE_SCHEMA_VERSION);

    const version = db
      .query<{ version: string }, []>(
        "select version from space_schema_version where id = 1",
      )
      .get();
    expect(version?.version).toBe(SPACE_SCHEMA_VERSION);

    const tables = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((r) => r.name);

    for (const expected of [
      "entities",
      "edges",
      "comp_space",
      "comp_room",
      "comp_matrix_origin",
      "comp_user",
      "comp_content",
      "comp_info",
      "comp_reaction",
      "comp_last_read",
      "roles",
      "member_roles",
      "role_rooms",
      "activity_item",
      "materialization_cursor",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test("is idempotent across re-initialisation", () => {
    const db = freshDb("schema-space.sql", "space_schema_version", SPACE_SCHEMA_VERSION);
    db.exec(readFileSync(join(THIS_DIR, "schema-space.sql"), "utf8"));
    const versionRows = db
      .query<{ count: number }, []>(
        "select count(*) as count from space_schema_version",
      )
      .get();
    expect(versionRows?.count).toBe(1);
  });

  test("foreign keys are enforced", () => {
    const db = freshDb("schema-space.sql", "space_schema_version", SPACE_SCHEMA_VERSION);
    expect(
      db.query<{ foreign_keys: number }, []>("pragma foreign_keys").get()
        ?.foreign_keys,
    ).toBe(1);

    expect(() =>
      db.run("insert into edges (head, tail, label) values (?, ?, ?)", [
        "nonexistent-head",
        "nonexistent-tail",
        "member",
      ]),
    ).toThrow();
  });

  test("can insert an entity then components referencing it", () => {
    const db = freshDb("schema-space.sql", "space_schema_version", SPACE_SCHEMA_VERSION);
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      "ent-1",
      "did:web:example.com",
    ]);
    db.run("insert into comp_room (entity, label) values (?, ?)", [
      "ent-1",
      "space.roomy.channel",
    ]);

    const room = db
      .query<{ entity: string; label: string }, []>(
        "select entity, label from comp_room where entity = 'ent-1'",
      )
      .get();
    expect(room).toEqual({ entity: "ent-1", label: "space.roomy.channel" });
  });
});

describe("global schema", () => {
  test("applies cleanly and writes the version row", () => {
    const db = freshDb("schema-global.sql", "global_schema_version", GLOBAL_SCHEMA_VERSION);
    const version = db
      .query<{ version: string }, []>(
        "select version from global_schema_version where id = 1",
      )
      .get();
    expect(version?.version).toBe(GLOBAL_SCHEMA_VERSION);

    const tables = db
      .query<{ name: string }, []>(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((r) => r.name);
    for (const expected of [
      "edges",
      "profiles",
      "entity_space",
      "pending_links",
      "mentions",
      "global_schema_migrations",
    ]) {
      expect(tables).toContain(expected);
    }
  });
});

describe("openDb", () => {
  test("returns an AsyncDatabase that can be used", async () => {
    const db = openDb({ path: ":memory:", isolated: true });
    const stmt = db.query("select 1 as val");
    const rows = await stmt.all<{ val: number }>();
    expect(rows).toEqual([{ val: 1 }]);
    await db.close();
  });
});
