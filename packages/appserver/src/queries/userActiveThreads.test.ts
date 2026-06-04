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
import type { Database } from "bun:sqlite";
import { openDb } from "../db/db.ts";
import { attachInMemoryReadState, initializeReadStateSchema } from "../db/readStateDb.ts";
import {
  upsertUserThreadActivity,
  queryActiveThreads,
  resolveThreadsByIds,
  isThread,
  purgeStaleThreadActivity,
} from "./userActiveThreads.ts";

/** Create a fresh db pair (main + attached readstate) for testing. */
function freshDb(): { db: Database; readStateDb: Database } {
  const db = openDb({ path: ":memory:", isolated: true });
  const readStateDb = attachInMemoryReadState(db);
  return { db, readStateDb };
}

const SPACE = "did:web:space.example";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD_A = "01THREADA00000000000000000".slice(0, 26);
const THREAD_B = "01THREADB00000000000000000".slice(0, 26);
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
  test("returns true for thread rooms", () => {
    const { db } = freshDb();
    seedBasic(db);
    expect(isThread(db, THREAD_A)).toBe(true);
  });

  test("returns false for channels", () => {
    const { db } = freshDb();
    seedBasic(db);
    expect(isThread(db, CHANNEL)).toBe(false);
  });

  test("returns false for non-existent rooms", () => {
    const { db } = freshDb();
    expect(isThread(db, "01NONEXIST0000000000000000")).toBe(false);
  });
});

describe("upsertUserThreadActivity", () => {
  test("inserts a new row on first call", () => {
    const { db } = freshDb();
    seedBasic(db);

    upsertUserThreadActivity(db, USER, THREAD_A, 1000);

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

  test("updates last_active_at on subsequent calls", () => {
    const { db } = freshDb();
    seedBasic(db);

    upsertUserThreadActivity(db, USER, THREAD_A, 1000);
    upsertUserThreadActivity(db, USER, THREAD_A, 2000);

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
  test("returns empty when no activity exists", () => {
    const { db } = freshDb();
    seedBasic(db);

    const result = queryActiveThreads(db, USER, SPACE);
    expect(result).toHaveLength(0);
  });

  test("returns threads within the 72h window, ordered by most recent", () => {
    const { db } = freshDb();
    seedBasic(db);

    const now = Date.now();
    upsertUserThreadActivity(db, USER, THREAD_A, now - 60_000); // 1 min ago
    upsertUserThreadActivity(db, USER, THREAD_B, now - 30_000); // 30 sec ago

    const result = queryActiveThreads(db, USER, SPACE);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(THREAD_B);
    expect(result[1]!.id).toBe(THREAD_A);
  });

  test("excludes threads older than 72 hours", () => {
    const { db } = freshDb();
    seedBasic(db);

    const now = Date.now();
    upsertUserThreadActivity(db, USER, THREAD_A, now - 73 * 60 * 60 * 1000); // 73h ago

    const result = queryActiveThreads(db, USER, SPACE);
    expect(result).toHaveLength(0);
  });

  test("scoped by user", () => {
    const { db } = freshDb();
    seedBasic(db);

    upsertUserThreadActivity(db, USER, THREAD_A, Date.now());
    upsertUserThreadActivity(db, OTHER_USER, THREAD_B, Date.now());

    const userResult = queryActiveThreads(db, USER, SPACE);
    expect(userResult).toHaveLength(1);
    expect(userResult[0]!.id).toBe(THREAD_A);
  });

  test("lazy backfill populates from user-authored messages", () => {
    const { db } = freshDb();
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
    const result = queryActiveThreads(db, USER, SPACE);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((r) => r.id === THREAD_A)).toBe(true);
  });
});

describe("resolveThreadsByIds", () => {
  test("returns metadata for given thread IDs", () => {
    const { db } = freshDb();
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

    const result = resolveThreadsByIds(db, [THREAD_A, THREAD_B]);

    expect(result.has(THREAD_A)).toBe(true);
    expect(result.has(THREAD_B)).toBe(true);

    const a = result.get(THREAD_A)!;
    expect(a.name).toBeNull(); // no comp_info name set
    expect(a.canonicalParent).toBe(CHANNEL);
    expect(a.latestTimestamp).toBe(new Date(ts).toISOString());
    expect(a.latestMembers).toHaveLength(1);
    expect(a.latestMembers[0]!.did).toBe(USER);
  });

  test("returns empty map for empty input", () => {
    const { db } = freshDb();
    expect(resolveThreadsByIds(db, []).size).toBe(0);
  });
});

describe("purgeStaleThreadActivity", () => {
  test("removes rows older than given cutoff", () => {
    const { db } = freshDb();
    seedBasic(db);

    upsertUserThreadActivity(db, USER, THREAD_A, 1000);
    upsertUserThreadActivity(db, USER, THREAD_B, 5000);

    const purged = purgeStaleThreadActivity(db, 3000);
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