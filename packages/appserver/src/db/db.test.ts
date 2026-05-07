import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SCHEMA_VERSION,
  SchemaVersionMismatchError,
  initializeSchema,
  openDb,
} from "./db.ts";

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

describe("appserver schema", () => {
  test("applies cleanly on a fresh database and writes the version row", () => {
    const db = freshDb();

    const version = db
      .query<{ version: string }, []>(
        "select version from roomy_schema_version where id = 1",
      )
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
      "events",
      "entities",
      "edges",
      "comp_space",
      "comp_room",
      "comp_user",
      "comp_content",
      "comp_info",
      "comp_reaction",
      "comp_last_read",
      "roles",
      "member_roles",
      "role_rooms",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  test("is idempotent across re-initialisation", () => {
    const db = freshDb();
    expect(() => initializeSchema(db)).not.toThrow();
    expect(() => initializeSchema(db)).not.toThrow();

    const versionRows = db
      .query<{ count: number }, []>(
        "select count(*) as count from roomy_schema_version",
      )
      .get();
    expect(versionRows?.count).toBe(1);
  });

  test("throws when the on-disk version does not match", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    db.run("update roomy_schema_version set version = '0' where id = 1");

    expect(() => initializeSchema(db)).toThrow(SchemaVersionMismatchError);
  });

  test("foreign keys are enforced", () => {
    const db = freshDb();
    expect(
      db
        .query<{ foreign_keys: number }, []>("pragma foreign_keys")
        .get()?.foreign_keys,
    ).toBe(1);

    expect(() =>
      db.run(
        "insert into edges (head, tail, label) values (?, ?, ?)",
        ["nonexistent-head", "nonexistent-tail", "member"],
      ),
    ).toThrow();
  });

  test("can insert an entity then components referencing it", () => {
    const db = freshDb();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      "ent-1",
      "did:web:example.com",
    ]);
    db.run(
      "insert into comp_room (entity, label) values (?, ?)",
      ["ent-1", "space.roomy.channel"],
    );

    const room = db
      .query<{ entity: string; label: string }, []>(
        "select entity, label from comp_room where entity = 'ent-1'",
      )
      .get();
    expect(room).toEqual({ entity: "ent-1", label: "space.roomy.channel" });
  });
});
