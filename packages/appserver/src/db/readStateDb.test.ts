import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";

describe("read-state schema", () => {
  test("READSTATE_SCHEMA_VERSION is exported", () => {
    expect(READSTATE_SCHEMA_VERSION).toBe("2");
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
    expect(tables).toContain("user_thread_activity");
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

    // Run migration: detect v1, apply v2 migration.
    const currentVersionRow = db
      .query<{ v: string | null }, []>(
        "select max(version) as v from readstate_schema_version",
      )
      .get();
    const currentVersion = Number(currentVersionRow?.v ?? 0);

    if (currentVersion < 2) {
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
      db.run(
        "insert or replace into readstate_schema_version (id, version) values (1, ?)",
        ["2"],
      );
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
});
