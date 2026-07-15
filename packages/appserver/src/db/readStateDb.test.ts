import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";

describe("read-state schema", () => {
  test("READSTATE_SCHEMA_VERSION is exported", () => {
    expect(READSTATE_SCHEMA_VERSION).toBe("4");
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
      // Replicate the MIGRATIONS from worker.ts inline.
      const migrations: { version: number; up: (db: Database) => void }[] = [
        {
          version: 2,
          up(db: Database) {
            db.exec(`
              create table if not exists user_thread_activity (
                user_did      text not null,
                thread_id     text not null,
                last_active_at integer not null,
                updated_at    integer not null default (unixepoch() * 1000),
                primary key (user_did, thread_id)
              ) strict
            `);
            db.exec(`
              create index if not exists idx_user_thread_activity_user
                on user_thread_activity(user_did, last_active_at desc)
            `);
          },
        },
        {
          version: 3,
          up(db: Database) {
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
              ) strict
            `);
            db.exec(`create index if not exists idx_push_subs_user on push_subscriptions(user_did)`);
            db.exec(`
              create table if not exists push_user_default (
                user_did text primary key,
                level    text not null check(level in ('silent','quiet','engaged','busy')) default 'engaged',
                updated_at integer not null default (unixepoch() * 1000)
              ) strict
            `);
            db.exec(`
              create table if not exists push_preferences (
                user_did  text not null,
                space_id  text not null,
                level     text not null check(level in ('silent','quiet','engaged','busy')),
                updated_at integer not null default (unixepoch() * 1000),
                primary key (user_did, space_id)
              ) strict
            `);
            db.exec(`
              create table if not exists user_room_participation (
                user_did         text not null,
                room_id          text not null,
                last_message_at  integer not null,
                updated_at       integer not null default (unixepoch() * 1000),
                primary key (user_did, room_id)
              ) strict
            `);
            db.exec(`
              create index if not exists idx_user_room_participation_user
                on user_room_participation(user_did, last_message_at desc)
            `);
            db.exec(`
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
              ) strict
            `);
            db.exec(`
              create index if not exists idx_notification_state_due
                on notification_state(notified, first_unseen_at)
            `);
          },
        },
        {
          version: 4,
          up(db: Database) {
            db.exec(`
              create table if not exists feature_flags (
                key             text primary key,
                global_enabled  integer not null default 0 check(global_enabled in (0, 1)),
                updated_at      integer not null default (unixepoch() * 1000)
              ) strict
            `);
            db.exec(`
              create table if not exists feature_flag_assignments (
                flag_key   text not null,
                user_did   text not null,
                updated_at integer not null default (unixepoch() * 1000),
                primary key (flag_key, user_did)
              ) strict
            `);
            db.exec(`
              create index if not exists idx_ff_assignments_flag
                on feature_flag_assignments(flag_key)
            `);
          },
        },
      ];

      for (const migration of migrations) {
        if (migration.version > currentVersion && migration.version <= expectedNum) {
          db.transaction(() => {
            migration.up(db);
            upsertVersion.run(String(migration.version));
          })();
        }
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
