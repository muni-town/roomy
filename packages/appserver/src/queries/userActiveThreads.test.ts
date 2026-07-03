/**
 * Tests for user_active_threads query helpers.
 *
 * Covers:
 *   - upsertUserThreadActivity
 *   - isThread
 *   - queryActiveThreads (including lazy backfill)
 *   - resolveThreadsByIds
 *   - purgeStaleThreadActivity
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  upsertUserThreadActivity,
  queryActiveThreads,
  resolveThreadsByIds,
  isThread,
  purgeStaleThreadActivity,
} from "./userActiveThreads.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const READSTATE_SCHEMA_PATH = join(__dirname, "..", "db", "readStateSchema.sql");
const SCHEMA_VERSION = "10-appserver.4";
const READSTATE_SCHEMA_VERSION = "2";

/** Create a fresh db pair (main + attached readstate) for testing. */
function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  // Apply main schema
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [
    SCHEMA_VERSION,
  ]);
  // Attach and apply readstate schema (separate exec calls to avoid bun:sqlite multi-stmt issue)
  db.exec("attach database ':memory:' as readstate");
  db.exec(
    "create table if not exists readstate_schema_version (id integer primary key check (id = 1), version text not null) strict",
  );
  db.exec(
    "create table if not exists readstate.read_positions (user_did text not null, room_id text not null, seen_up_to text not null, unread_count integer not null default 0, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
  );
  db.exec(
    "create table if not exists readstate.user_thread_activity (user_did text not null, thread_id text not null, last_active_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, thread_id)) strict",
  );
  db.run(
    "insert or replace into readstate_schema_version (id, version) values (1, ?)",
    [READSTATE_SCHEMA_VERSION],
  );
  return { db, asyncDb: toAsyncDb(db) };
}

const SPACE = "did:web:space.example";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD_A = "01THREADA000000000000000000".slice(0, 26);
const THREAD_B = "01THREADB000000000000000000".slice(0, 26);
const USER = "did:plc:alice";
const OTHER_USER = "did:plc:bob";

function seedBasic(db: Database) {
  // Space entity
  db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  db.run("insert into comp_space (entity) values (?)", [SPACE]);

  // Channel
  db.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );

  // Thread A (linked to channel)
  db.run("insert into entities (id, stream_id) values (?, ?)", [THREAD_A, SPACE]);
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [THREAD_A],
  );
  db.run(
    `insert into edges (head, tail, label, payload)
     values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [CHANNEL, THREAD_A],
  );

  // Thread B (linked to channel)
  db.run("insert into entities (id, stream_id) values (?, ?)", [THREAD_B, SPACE]);
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [THREAD_B],
  );
  db.run(
    `insert into edges (head, tail, label, payload)
     values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [CHANNEL, THREAD_B],
  );

  // User entity
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, SPACE]);
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [OTHER_USER, SPACE]);
}

describe("isThread", () => {
  test("returns true for thread rooms", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);
    expect(await isThread(asyncDb, THREAD_A)).toBe(true);
  });

  test("returns false for channels", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);
    expect(await isThread(asyncDb, CHANNEL)).toBe(false);
  });

  test("returns false for non-existent rooms", async () => {
    const { asyncDb } = freshDb();
    expect(await isThread(asyncDb, "01NONEXIST0000000000000000")).toBe(false);
  });
});

describe("upsertUserThreadActivity", () => {
  test("inserts a new row on first call", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    await upsertUserThreadActivity(asyncDb, USER, THREAD_A, 1000);

    const rows = db
      .query<{ user_did: string; thread_id: string; last_active_at: number }, []>(
        "select * from readstate.user_thread_activity",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_did).toBe(USER);
    expect(rows[0]!.thread_id).toBe(THREAD_A);
    expect(rows[0]!.last_active_at).toBe(1000);
  });

  test("updates last_active_at on subsequent calls", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    await upsertUserThreadActivity(asyncDb, USER, THREAD_A, 1000);
    await upsertUserThreadActivity(asyncDb, USER, THREAD_A, 2000);

    const rows = db
      .query<{ last_active_at: number }, []>(
        "select last_active_at from readstate.user_thread_activity",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_active_at).toBe(2000);
  });
});

describe("queryActiveThreads", () => {
  test("returns empty when no activity exists", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    const result = await queryActiveThreads(asyncDb, USER, SPACE);
    expect(result).toHaveLength(0);
  });

  test("returns threads within the 72h window, ordered by most recent", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    const now = Date.now();
    await upsertUserThreadActivity(asyncDb, USER, THREAD_A, now - 60_000); // 1 min ago
    await upsertUserThreadActivity(asyncDb, USER, THREAD_B, now - 30_000); // 30 sec ago

    const result = await queryActiveThreads(asyncDb, USER, SPACE);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(THREAD_B);
    expect(result[1]!.id).toBe(THREAD_A);
  });

  test("excludes threads older than 72 hours", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    const now = Date.now();
    await upsertUserThreadActivity(asyncDb, USER, THREAD_A, now - 73 * 60 * 60 * 1000); // 73h ago

    const result = await queryActiveThreads(asyncDb, USER, SPACE);
    expect(result).toHaveLength(0);
  });

  test("scoped by user", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    await upsertUserThreadActivity(asyncDb, USER, THREAD_A, Date.now());
    await upsertUserThreadActivity(asyncDb, OTHER_USER, THREAD_B, Date.now());

    const userResult = await queryActiveThreads(asyncDb, USER, SPACE);
    expect(userResult).toHaveLength(1);
    expect(userResult[0]!.id).toBe(THREAD_A);
  });

  test("lazy backfill populates from user-authored messages", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    // Insert a message authored by USER in THREAD_A
    const msgId = "01MSGLAZYBACKFILL00TEST0000";
    const timestamp = Date.now() - 60_000;
    db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      msgId,
      SPACE,
      THREAD_A,
    ]);
    db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
      [msgId, Buffer.from("hello"), msgId, timestamp],
    );
    db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      USER,
    ]);

    // No prior user_thread_activity rows — backfill should trigger
    const result = await queryActiveThreads(asyncDb, USER, SPACE);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((r) => r.id === THREAD_A)).toBe(true);
  });
});

describe("resolveThreadsByIds", () => {
  test("returns metadata for given thread IDs", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    // Post a message in THREAD_A
    const msgId = "01MSGRESOLVE0000000000000";
    const ts = Date.now() - 60_000;
    db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      msgId,
      SPACE,
      THREAD_A,
    ]);
    db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
      [msgId, Buffer.from("hi"), msgId, ts],
    );
    db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      USER,
    ]);

    const result = await resolveThreadsByIds(asyncDb, [THREAD_A, THREAD_B]);

    expect(result.has(THREAD_A)).toBe(true);
    expect(result.has(THREAD_B)).toBe(true);

    const a = result.get(THREAD_A)!;
    expect(a.name).toBeNull(); // no comp_info name set
    expect(a.canonicalParent).toBe(CHANNEL);
    expect(a.latestTimestamp).toBe(new Date(ts).toISOString());
    expect(a.latestMembers).toHaveLength(1);
    expect(a.latestMembers[0]!.did).toBe(USER);
  });

  test("returns empty map for empty input", async () => {
    const { asyncDb } = freshDb();
    expect((await resolveThreadsByIds(asyncDb, [])).size).toBe(0);
  });
});

describe("purgeStaleThreadActivity", () => {
  test("removes rows older than given cutoff", async () => {
    const { db, asyncDb } = freshDb();
    seedBasic(db);

    await upsertUserThreadActivity(asyncDb, USER, THREAD_A, 1000);
    await upsertUserThreadActivity(asyncDb, USER, THREAD_B, 5000);

    const purged = await purgeStaleThreadActivity(asyncDb, 3000);
    expect(purged).toBe(1);

    const remaining = db
      .query<{ thread_id: string }, []>(
        "select thread_id from readstate.user_thread_activity",
      )
      .all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.thread_id).toBe(THREAD_B);
  });
});
