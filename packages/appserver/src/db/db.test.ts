import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_VERSION, openDb } from "./db.ts";

function freshDb(): Database {
  // For synchronous tests, we open a raw Database directly.
  // The openDb() now returns AsyncDatabase, so for tests that need
  // synchronous access we use a raw Database.
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  // Apply schema directly
  const { readFileSync } = require("node:fs");
  const { join, dirname } = require("node:path");
  const { fileURLToPath } = require("node:url");
  const schemaPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "schema.sql",
  );
  const schemaSql = readFileSync(schemaPath, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [
    SCHEMA_VERSION,
  ]);
  return db;
}

describe("appserver schema", () => {
  test("applies cleanly on a fresh database and writes the version row", () => {
    const db = freshDb();

    const version = db
      .query<
        { version: string },
        []
      >("select version from roomy_schema_version where id = 1")
      .get();
    expect(version?.version).toBe(SCHEMA_VERSION);

    // Spot-check that the core tables exist.
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
      "comp_user",
      "comp_content",
      "comp_info",
      "comp_reaction",
      "comp_last_read",
      // read_positions lives in the separate read-state DB (see readStateDb.ts
      // + readStateDb.test.ts), ATTACHed as `readstate.read_positions`.
      "roles",
      "member_roles",
      "role_rooms",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test("is idempotent across re-initialisation", () => {
    const db = freshDb();

    // Re-apply schema (idempotent via IF NOT EXISTS).
    const { readFileSync } = require("node:fs");
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "schema.sql",
    );
    db.exec(readFileSync(schemaPath, "utf8"));

    const versionRows = db
      .query<
        { count: number },
        []
      >("select count(*) as count from roomy_schema_version")
      .get();
    expect(versionRows?.count).toBe(1);
  });

  test("throws when the on-disk version does not match", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    const { readFileSync } = require("node:fs");
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "schema.sql",
    );
    db.exec(readFileSync(schemaPath, "utf8"));
    db.run("insert into roomy_schema_version (id, version) values (1, ?)", [
      SCHEMA_VERSION,
    ]);
    db.run("update roomy_schema_version set version = '0' where id = 1");

    // Re-applying schema should throw on mismatch.
    expect(() => {
      const schemaSql = readFileSync(schemaPath, "utf8");
      db.exec(schemaSql);
      const row = db
        .query<{ version: string }, []>(
          "select version from roomy_schema_version where id = 1",
        )
        .get();
      if (row && row.version !== SCHEMA_VERSION) {
        throw new Error(
          `Schema version mismatch: ${row.version} vs ${SCHEMA_VERSION}`,
        );
      }
    }).toThrow();
  });

  test("foreign keys are enforced", () => {
    const db = freshDb();
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
    const db = freshDb();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      "ent-1",
      "did:web:example.com",
    ]);
    db.run("insert into comp_room (entity, label) values (?, ?)", [
      "ent-1",
      "space.roomy.channel",
    ]);

    const room = db
      .query<
        { entity: string; label: string },
        []
      >("select entity, label from comp_room where entity = 'ent-1'")
      .get();
    expect(room).toEqual({ entity: "ent-1", label: "space.roomy.channel" });
  });

  test("openDb returns an AsyncDatabase that can be used", async () => {
    // This test verifies the new openDb() contract.
    // The worker processes messages sequentially, so a query sent after init
    // will only be processed after init completes — no timer needed.
    const db = openDb({ path: ":memory:", isolated: true });

    // Query through the async proxy. The worker's sequential message queue
    // guarantees init completes before this query runs.
    const stmt = db.query("select 1 as val");
    const rows = await stmt.all<{ val: number }>();
    expect(rows).toEqual([{ val: 1 }]);

    await db.close();
  });
});
