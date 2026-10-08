/**
 * Tests for user_active_threads query helpers.
 *
 * Covers:
 *   - upsertUserThreadActivity
 *   - isThread
 *   - queryActiveThreads (including lazy backfill)
 *   - resolveThreadsByIds
 *   - purgeStaleThreadActivity
 *
 * `queryActiveThreads` takes `(readStateDb, spaceDb, userDid, spaceId)`.
 * Read-state rows (`user_thread_activity`) go into the read-state DB via
 * `openReadStateDb`; per-space rows (entities, comp_room, comp_content, edges,
 * comp_info) go into the per-space DB via `openSpaceDb`. Other helpers
 * (`upsertUserThreadActivity`, `isThread`, `resolveThreadsByIds`,
 * `purgeStaleThreadActivity`) take a single handle, which the test points at
 * the appropriate DB for the tables they touch.
 */

import { describe, expect, test } from "bun:test";
import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import {
  upsertUserThreadActivity,
  refreshThreadActivityOnMessage,
  queryActiveThreads,
  resolveThreadsByIds,
  isThread,
  purgeStaleThreadActivity,
} from "./userActiveThreads.ts";
import { readRoomActivityProjection } from "./roomActivityProjection.ts";

const SPACE = "did:web:space.example";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD_A = "01THREADA000000000000000000".slice(0, 26);
const THREAD_B = "01THREADB000000000000000000".slice(0, 26);
const USER = "did:plc:alice";
const OTHER_USER = "did:plc:bob";

/** Create fresh worker-backed DBs (read-state + per-space) for testing. */
function freshDb(): { readState: DbLike; spaceDb: DbLike } {
  closeDb();
  openDb({ path: ":memory:" });
  return {
    readState: openReadStateDb(),
    spaceDb: openSpaceDb(SPACE),
  };
}

async function seedBasic(spaceDb: DbLike) {
  // Space entity
  await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await spaceDb.run("insert into comp_space (entity) values (?)", [SPACE]);

  // Channel
  await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  await spaceDb.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );

  // Thread A (linked to channel)
  await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [THREAD_A, SPACE]);
  await spaceDb.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [THREAD_A],
  );
  await spaceDb.run(
    `insert into edges (head, tail, label, payload)
     values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [CHANNEL, THREAD_A],
  );

  // Thread B (linked to channel)
  await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [THREAD_B, SPACE]);
  await spaceDb.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [THREAD_B],
  );
  await spaceDb.run(
    `insert into edges (head, tail, label, payload)
     values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [CHANNEL, THREAD_B],
  );

  // User entities
  await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, SPACE]);
  await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [OTHER_USER, SPACE]);
}

/**
 * The same DB with `room_activity` made unreadable, so `resolveThreadsByIds`
 * takes its scan fallback. The projection is an optimisation; the scan is the
 * behaviour it has to reproduce.
 */
function noProjectionDb(spaceDb: DbLike): DbLike {
  return {
    ...spaceDb,
    query(sql: string) {
      if (sql.includes("room_activity")) throw new Error("no such table: room_activity");
      return spaceDb.query(sql);
    },
  };
}

describe("isThread", () => {
  test("returns true for thread rooms", async () => {
    const { spaceDb } = freshDb();
    await seedBasic(spaceDb);
    expect(await isThread(spaceDb, THREAD_A)).toBe(true);
  });

  test("returns false for channels", async () => {
    const { spaceDb } = freshDb();
    await seedBasic(spaceDb);
    expect(await isThread(spaceDb, CHANNEL)).toBe(false);
  });

  test("returns false for non-existent rooms", async () => {
    const { spaceDb } = freshDb();
    expect(await isThread(spaceDb, "01NONEXIST0000000000000000")).toBe(false);
  });
});

describe("upsertUserThreadActivity", () => {
  test("inserts a new row on first call", async () => {
    const { readState } = freshDb();

    await upsertUserThreadActivity(readState, USER, THREAD_A, SPACE, 1000);

    const rows = await readState
      .query(
        "select * from user_thread_activity",
      )
      .all<{ user_did: string; thread_id: string; last_active_at: number }>();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_did).toBe(USER);
    expect(rows[0]!.thread_id).toBe(THREAD_A);
    expect(rows[0]!.last_active_at).toBe(1000);
  });

  test("updates last_active_at on subsequent calls", async () => {
    const { readState } = freshDb();

    await upsertUserThreadActivity(readState, USER, THREAD_A, SPACE, 1000);
    await upsertUserThreadActivity(readState, USER, THREAD_A, SPACE, 2000);

    const rows = await readState
      .query(
        "select last_active_at from user_thread_activity",
      )
      .all<{ last_active_at: number }>();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_active_at).toBe(2000);
  });
});

describe("refreshThreadActivityOnMessage", () => {
  test("refreshes last_active_at for every user tracking the thread and registers the author", async () => {
    const { readState, spaceDb } = freshDb();
    await seedBasic(spaceDb);

    const now = Date.now();
    await upsertUserThreadActivity(readState, USER, THREAD_A, SPACE, now - 60_000);
    await upsertUserThreadActivity(readState, OTHER_USER, THREAD_A, SPACE, now - 60_000);

    const AUTHOR = "did:plc:carol";
    await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [AUTHOR, SPACE]);
    const msgTime = now - 10_000;
    await refreshThreadActivityOnMessage(readState, THREAD_A, AUTHOR, SPACE, msgTime);

    const rows = await readState
      .query(
        "select user_did, last_active_at from user_thread_activity where thread_id = ?",
      )
      .all<{ user_did: string; last_active_at: number }>(THREAD_A);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.last_active_at).toBe(msgTime);
    }
    expect(rows.some((r) => r.user_did === AUTHOR)).toBe(true);
  });

  test("does not touch activity for other threads", async () => {
    const { readState, spaceDb } = freshDb();
    await seedBasic(spaceDb);

    const now = Date.now();
    await upsertUserThreadActivity(readState, USER, THREAD_B, SPACE, now - 60_000);

    await refreshThreadActivityOnMessage(readState, THREAD_A, USER, SPACE, now);

    const b = await readState
      .query(
        "select last_active_at from user_thread_activity where user_did = ? and thread_id = ?",
      )
      .get<{ last_active_at: number }>(USER, THREAD_B);
    expect(b?.last_active_at).toBe(now - 60_000);
  });
});

describe("queryActiveThreads", () => {
  test("returns empty when no activity exists", async () => {
    const { readState, spaceDb } = freshDb();
    await seedBasic(spaceDb);

    const result = await queryActiveThreads(readState, spaceDb, USER, SPACE);
    expect(result).toHaveLength(0);
  });

  test("returns threads within the 120h window, ordered by most recent", async () => {
    const { readState, spaceDb } = freshDb();
    await seedBasic(spaceDb);

    const now = Date.now();
    await upsertUserThreadActivity(readState, USER, THREAD_A, SPACE, now - 60_000); // 1 min ago
    await upsertUserThreadActivity(readState, USER, THREAD_B, SPACE, now - 30_000); // 30 sec ago

    const result = await queryActiveThreads(readState, spaceDb, USER, SPACE);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(THREAD_B);
    expect(result[1]!.id).toBe(THREAD_A);
  });

  test("excludes threads older than 120 hours", async () => {
    const { readState, spaceDb } = freshDb();
    await seedBasic(spaceDb);

    const now = Date.now();
    await upsertUserThreadActivity(readState, USER, THREAD_A, SPACE, now - 121 * 60 * 60 * 1000); // 121h ago

    const result = await queryActiveThreads(readState, spaceDb, USER, SPACE);
    expect(result).toHaveLength(0);
  });

  test("scoped by user", async () => {
    const { readState, spaceDb } = freshDb();
    await seedBasic(spaceDb);

    await upsertUserThreadActivity(readState, USER, THREAD_A, SPACE, Date.now());
    await upsertUserThreadActivity(readState, OTHER_USER, THREAD_B, SPACE, Date.now());

    const userResult = await queryActiveThreads(readState, spaceDb, USER, SPACE);
    expect(userResult).toHaveLength(1);
    expect(userResult[0]!.id).toBe(THREAD_A);
  });

  test("lazy backfill populates from user-authored messages", async () => {
    const { readState, spaceDb } = freshDb();
    await seedBasic(spaceDb);

    // Insert a message authored by USER in THREAD_A
    const msgId = "01MSGLAZYBACKFILL00TEST0000";
    const timestamp = Date.now() - 60_000;
    await spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      msgId,
      SPACE,
      THREAD_A,
    ]);
    await spaceDb.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
      [msgId, Buffer.from("hello"), msgId, timestamp],
    );
    await spaceDb.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      USER,
    ]);

    // No prior user_thread_activity rows — backfill should trigger
    const result = await queryActiveThreads(readState, spaceDb, USER, SPACE);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((r) => r.id === THREAD_A)).toBe(true);
  });
});

describe("resolveThreadsByIds", () => {
  test("returns metadata for given thread IDs", async () => {
    const { spaceDb } = freshDb();
    await seedBasic(spaceDb);

    // Post a message in THREAD_A
    const msgId = "01MSGRESOLVE0000000000000";
    const ts = Date.now() - 60_000;
    await spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      msgId,
      SPACE,
      THREAD_A,
    ]);
    await spaceDb.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
      [msgId, Buffer.from("hi"), msgId, ts],
    );
    await spaceDb.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      USER,
    ]);

    const result = await resolveThreadsByIds(spaceDb, [THREAD_A, THREAD_B]);

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
    const { spaceDb } = freshDb();
    expect((await resolveThreadsByIds(spaceDb, [])).size).toBe(0);
  });
});

/**
 * `resolveThreadsByIds` reads its activity columns from the `room_activity`
 * projection. These tests read the same fixture through the scan fallback and
 * through the projection and require the two to agree exactly — the
 * optimisation is only sound if the thread metadata is unchanged.
 */
describe("resolveThreadsByIds activity columns", () => {
  /** Post a message with an explicit timestamp, as the materialiser leaves it. */
  async function postM(
    spaceDb: DbLike,
    id: string,
    room: string,
    did: string,
    ts: number | null,
  ): Promise<void> {
    await spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      id,
      SPACE,
      room,
    ]);
    await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
    await spaceDb.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
      [id, Buffer.from("hi"), id, ts],
    );
    await spaceDb.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, did]);
  }

  /** Post more messages than the board renders, from distinct authors. */
  async function postMany(spaceDb: DbLike, room: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await postM(spaceDb, `01MSGPARITY${String(i).padStart(13, "0")}`, room, `did:plc:author${i}`, 1000 + i);
    }
  }

  test("projection matches the scan for multiple messages per thread", async () => {
    const { spaceDb } = freshDb();
    await seedBasic(spaceDb);

    // Four authors in THREAD_A, two in THREAD_B, one of them older.
    await postM(spaceDb, "01MSGPARITYA000000000000001", THREAD_A, USER, 5000);
    await postM(spaceDb, "01MSGPARITYA000000000000002", THREAD_A, OTHER_USER, 9000);
    await postM(spaceDb, "01MSGPARITYA000000000000003", THREAD_A, "did:plc:carol", 7000);
    await postM(spaceDb, "01MSGPARITYA000000000000004", THREAD_A, USER, 3000);
    await postM(spaceDb, "01MSGPARITYB000000000000001", THREAD_B, "did:plc:dave", 2000);
    await postM(spaceDb, "01MSGPARITYB000000000000002", THREAD_B, "did:plc:erin", 8000);

    const scanned = await resolveThreadsByIds(noProjectionDb(spaceDb), [THREAD_A, THREAD_B]);
    // The projection starts empty, so the first read warms it and the second
    // reads it — and the columns must be identical.
    await resolveThreadsByIds(spaceDb, [THREAD_A, THREAD_B]);
    const projected = await resolveThreadsByIds(spaceDb, [THREAD_A, THREAD_B]);
    // A silent fallback would make the comparison pass trivially.
    expect(await readRoomActivityProjection(spaceDb, [THREAD_A, THREAD_B])).not.toBeNull();
    expect([...projected.entries()]).toEqual([...scanned.entries()]);
    expect(projected.get(THREAD_A)!.latestTimestamp).toBe(new Date(9000).toISOString());
    expect(projected.get(THREAD_B)!.latestTimestamp).toBe(new Date(8000).toISOString());
  });

  test("the three rendered participants are the newest authors, in order", async () => {
    const { spaceDb } = freshDb();
    await seedBasic(spaceDb);

    // A fourth author who is neither newest nor oldest must be dropped by the
    // three-member cap, in both paths.
    await postMany(spaceDb, THREAD_A, 4);
    await resolveThreadsByIds(spaceDb, [THREAD_A]);
    const projected = await resolveThreadsByIds(spaceDb, [THREAD_A]);
    const scanned = await resolveThreadsByIds(noProjectionDb(spaceDb), [THREAD_A]);

    const dids = (r: { latestMembers: Array<{ did: string }> }) =>
      r.latestMembers.map((m) => m.did);
    expect(dids(projected.get(THREAD_A)!)).toHaveLength(3);
    expect(dids(projected.get(THREAD_A)!)).toEqual(dids(scanned.get(THREAD_A)!));
    // Newest-first: author3 posted at 1003, author2 at 1002, author1 at 1001.
    expect(dids(projected.get(THREAD_A)!)).toEqual([
      "did:plc:author3",
      "did:plc:author2",
      "did:plc:author1",
    ]);
  });

  test("a thread with no messages has no timestamp and no members", async () => {
    const { spaceDb } = freshDb();
    await seedBasic(spaceDb);

    const projected = await resolveThreadsByIds(spaceDb, [THREAD_A]);
    const scanned = await resolveThreadsByIds(noProjectionDb(spaceDb), [THREAD_A]);

    expect([...projected.entries()]).toEqual([...scanned.entries()]);
    expect(projected.get(THREAD_A)!.latestTimestamp).toBeNull();
    expect(projected.get(THREAD_A)!.latestMembers).toEqual([]);
  });
});

describe("purgeStaleThreadActivity", () => {
  test("removes rows older than given cutoff", async () => {
    const { readState } = freshDb();

    await upsertUserThreadActivity(readState, USER, THREAD_A, SPACE, 1000);
    await upsertUserThreadActivity(readState, USER, THREAD_B, SPACE, 5000);

    const purged = await purgeStaleThreadActivity(readState, 3000);
    expect(purged).toBe(1);

    const remaining = await readState
      .query(
        "select thread_id from user_thread_activity",
      )
      .all<{ thread_id: string }>();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.thread_id).toBe(THREAD_B);
  });
});
