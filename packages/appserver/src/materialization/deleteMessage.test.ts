/**
 * Tests for the derived-state side-effects of `deleteMessage`.
 *
 * Deleting the entity rows alone would leave the appserver's derived state
 * describing a message that does not exist:
 *
 *   - the room's `activity_item.recent_message_ids` window would keep naming
 *     the deleted message (and the room would keep appearing in the activity
 *     feed after every one of its messages was deleted), and
 *   - every reader's `unread_count` would keep counting it, so an unread badge
 *     could never be cleared.
 *
 * These pin the unwind, including the two ways it can be wrong: decrementing
 * a message a user had already read, and going below zero.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import type { DecodedStreamEvent } from "@roomy-space/sdk";
import {
  applyDeleteSideEffects,
  captureDeleteSortIndexes,
  collectPendingDeletes,
} from "./deleteMessage.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const READSTATE_SCHEMA_PATH = join(__dirname, "..", "db", "readStateSchema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const SPACE = "did:web:space.example";
const ROOM = "01CHANNEL00000000000000000";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

/**
 * Real ULIDs one second apart (t = 1700000000000 / 001000 / 002000). They must
 * be genuine ULIDs: `rebuildActivityWindow` derives each entry's feed timestamp
 * with `decodeTime(sort_idx)`, so a synthetic string yields garbage. Ascending
 * order makes the `sort_idx > seen_up_to` comparisons read naturally.
 */
const S1 = "01HF7YAT00Z8SA759H2SDDCH32";
const S2 = "01HF7YATZ8WP5D8EG2QDZPWCNW";
const S3 = "01HF7YAVYGAPZA41KB05BTJR1F";

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
}

function freshReadStateDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(READSTATE_SCHEMA_PATH, "utf8"));
  return { db, asyncDb: toAsyncDb(db) };
}

/** Seed the space + channel + users the derived-state rows reference. */
function seedFixtures(db: Database) {
  db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  db.run("insert into comp_space (entity) values (?)", [SPACE]);
  db.run("insert into comp_info (entity, name) values (?, ?)", [SPACE, "Test Space"]);
  db.run("insert into entities (id, stream_id) values (?, ?)", [ROOM, SPACE]);
  db.run(
    "insert into comp_room (entity, label) values (?, 'space.roomy.channel')",
    [ROOM],
  );
  db.run("insert into comp_info (entity, name) values (?, ?)", [ROOM, "general"]);
  for (const did of [ALICE, BOB]) {
    db.run("insert into entities (id, stream_id) values (?, ?)", [did, did]);
    db.run("insert into comp_user (did, handle) values (?, NULL)", [did]);
  }
}

/**
 * Insert a message whose `sort_idx` doubles as the ordering key the unread
 * math compares against, so tests pass explicit ascending values.
 */
function seedMessage(db: Database, id: string, sortIdx: string) {
  db.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [id, SPACE, ROOM, sortIdx],
  );
  db.run(
    `insert into comp_content (entity, mime_type, data, last_edit, timestamp)
     values (?, 'text/plain', ?, ?, ?)`,
    [id, Buffer.from("hello"), id, Date.now()],
  );
  db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, ALICE]);
}

/** Replace the room's activity window with `entries` (newest first). */
function seedActivityItem(db: Database, entries: Array<{ id: string; ts: number }>) {
  db.run(
    `insert or replace into activity_item
       (room_id, space_id, is_thread, parent_channel_id, parent_channel_name,
        last_activity_at, recent_message_ids, room_name, space_name, space_avatar, updated_at)
     values (?, ?, 0, null, null, ?, ?, 'general', 'Test Space', null, 0)`,
    [ROOM, SPACE, entries[0]?.ts ?? 0, JSON.stringify(entries)],
  );
}

function readWindow(db: Database): Array<{ id: string; ts: number }> | null {
  const row = db
    .query("select recent_message_ids from activity_item where room_id = ?")
    .get(ROOM) as { recent_message_ids: string } | null;
  return row ? JSON.parse(row.recent_message_ids) : null;
}

function activityItemExists(db: Database): boolean {
  return (
    db.query("select 1 as n from activity_item where room_id = ?").get(ROOM) !== null
  );
}

function seedReadPosition(db: Database, userDid: string, seenUpTo: string, unread: number) {
  db.run(
    `insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
     values (?, ?, ?, ?, ?, 0)`,
    [userDid, ROOM, SPACE, seenUpTo, unread],
  );
}

function unreadOf(db: Database, userDid: string): number {
  const row = db
    .query("select unread_count from read_positions where user_did = ? and room_id = ?")
    .get(userDid, ROOM) as { unread_count: number } | null;
  return row?.unread_count ?? -1;
}

/** The window timestamp of the newest remaining message (S2's ULID time). */
const S2_TIME = 1700000001000;

describe("deleteMessage side-effects", () => {
  test("rebuilds the activity window from the room's remaining messages", async () => {
    const { db, asyncDb } = freshDb();
    seedFixtures(db);
    seedMessage(db, S1, S1);
    seedMessage(db, S2, S2);
    seedMessage(db, S3, S3);
    seedActivityItem(db, [
      { id: S3, ts: 1700000002000 },
      { id: S2, ts: S2_TIME },
      { id: S1, ts: 1700000000000 },
    ]);

    // Delete the newest message: the window must drop exactly that entry.
    const sortIndexes = await captureDeleteSortIndexes(asyncDb, [S3]);
    db.run("delete from entities where id = ?", [S3]);

    await applyDeleteSideEffects(
      asyncDb,
      [{ roomId: ROOM, sortIdx: sortIndexes.get(S3)! }],
      { isBackfill: false },
    );

    const window = readWindow(db);
    expect(window).not.toBeNull();
    expect(window!.map((e) => e.id)).toEqual([S2, S1]);
    // The window's ordering timestamp follows its new newest entry.
    const row = db
      .query("select last_activity_at from activity_item where room_id = ?")
      .get(ROOM) as { last_activity_at: number };
    expect(row.last_activity_at).toBe(S2_TIME);
  });

  test("deletes the activity_item row when the room has no messages left", async () => {
    const { db, asyncDb } = freshDb();
    seedFixtures(db);
    seedMessage(db, S1, S1);
    seedActivityItem(db, [{ id: S1, ts: 1700000000000 }]);

    const sortIndexes = await captureDeleteSortIndexes(asyncDb, [S1]);
    db.run("delete from entities where id = ?", [S1]);

    await applyDeleteSideEffects(
      asyncDb,
      [{ roomId: ROOM, sortIdx: sortIndexes.get(S1)! }],
      { isBackfill: false },
    );

    // The room must stop being listed in the feed at all.
    expect(activityItemExists(db)).toBe(false);
  });

  test("decrements exactly the messages that were unread", async () => {
    const { db: spaceDb, asyncDb } = freshDb();
    const { db: readDb, asyncDb: readAsyncDb } = freshReadStateDb();
    seedFixtures(spaceDb);
    seedMessage(spaceDb, S1, S1);
    seedMessage(spaceDb, S2, S2);
    seedMessage(spaceDb, S3, S3);
    seedActivityItem(spaceDb, [{ id: S3, ts: 1700000002000 }]);
    // Alice has read S1 only (2 unread); Bob has read everything (0 unread).
    seedReadPosition(readDb, ALICE, S1, 2);
    seedReadPosition(readDb, BOB, S3, 0);

    const sortIndexes = await captureDeleteSortIndexes(asyncDb, [S3]);
    spaceDb.run("delete from entities where id = ?", [S3]);

    await applyDeleteSideEffects(
      asyncDb,
      [{ roomId: ROOM, sortIdx: sortIndexes.get(S3)! }],
      { readStateDb: readAsyncDb, isBackfill: false },
    );

    // Alice loses the one unread message she still owed.
    expect(unreadOf(readDb, ALICE)).toBe(1);
    // Bob had already read it — his count must not go negative.
    expect(unreadOf(readDb, BOB)).toBe(0);
  });

  test("a message the user had already read does not decrement", async () => {
    const { db: spaceDb, asyncDb } = freshDb();
    const { db: readDb, asyncDb: readAsyncDb } = freshReadStateDb();
    seedFixtures(spaceDb);
    seedMessage(spaceDb, S1, S1);
    seedMessage(spaceDb, S2, S2);
    seedMessage(spaceDb, S3, S3);
    seedActivityItem(spaceDb, [{ id: S3, ts: 1700000002000 }]);
    // Alice is up to date: 0 unread, watermark past every message.
    seedReadPosition(readDb, ALICE, S3, 0);

    const sortIndexes = await captureDeleteSortIndexes(asyncDb, [S1]);
    spaceDb.run("delete from entities where id = ?", [S1]);

    await applyDeleteSideEffects(
      asyncDb,
      [{ roomId: ROOM, sortIdx: sortIndexes.get(S1)! }],
      { readStateDb: readAsyncDb, isBackfill: false },
    );

    expect(unreadOf(readDb, ALICE)).toBe(0);
  });

  test("deleting a batch decrements each unread message once", async () => {
    const { db: spaceDb, asyncDb } = freshDb();
    const { db: readDb, asyncDb: readAsyncDb } = freshReadStateDb();
    seedFixtures(spaceDb);
    seedMessage(spaceDb, S1, S1);
    seedMessage(spaceDb, S2, S2);
    seedMessage(spaceDb, S3, S3);
    seedActivityItem(spaceDb, [{ id: S3, ts: 1700000002000 }]);
    seedReadPosition(readDb, ALICE, S1, 2);

    const sortIndexes = await captureDeleteSortIndexes(asyncDb, [S2, S3]);
    spaceDb.run("delete from entities where id in (?, ?)", [S2, S3]);

    await applyDeleteSideEffects(
      asyncDb,
      [
        { roomId: ROOM, sortIdx: sortIndexes.get(S2)! },
        { roomId: ROOM, sortIdx: sortIndexes.get(S3)! },
      ],
      { readStateDb: readAsyncDb, isBackfill: false },
    );

    expect(unreadOf(readDb, ALICE)).toBe(0);
    expect(readWindow(spaceDb)!.map((e) => e.id)).toEqual([S1]);
  });

  test("backfill rebuilds the window but leaves read-state alone", async () => {
    const { db: spaceDb, asyncDb } = freshDb();
    const { db: readDb, asyncDb: readAsyncDb } = freshReadStateDb();
    seedFixtures(spaceDb);
    seedMessage(spaceDb, S2, S2);
    seedActivityItem(spaceDb, [{ id: S3, ts: 1700000002000 }]);
    seedReadPosition(readDb, ALICE, S1, 5);

    await applyDeleteSideEffects(
      asyncDb,
      [{ roomId: ROOM, sortIdx: S3 }],
      { readStateDb: readAsyncDb, isBackfill: true },
    );

    expect(readWindow(spaceDb)!.map((e) => e.id)).toEqual([S2]);
    // Replaying history must not touch appserver-owned read-state.
    expect(unreadOf(readDb, ALICE)).toBe(5);
  });
});

describe("collectPendingDeletes", () => {
  /** A decoded stream event carrying just the fields the collector reads. */
  function decodedDelete(room: string, messageId: string, idx = 0) {
    return {
      idx,
      user: ALICE,
      event: {
        id: messageId,
        $type: "space.roomy.message.deleteMessage.v0",
        room,
        messageId,
      },
    } as unknown as DecodedStreamEvent;
  }

  test("reads each victim's ordering key before the rows are deleted", async () => {
    const { db, asyncDb } = freshDb();
    seedFixtures(db);
    seedMessage(db, S1, S1);
    seedMessage(db, S2, S2);

    const pending = await collectPendingDeletes(asyncDb, [
      decodedDelete(ROOM, S1, 0),
      decodedDelete(ROOM, S2, 1),
    ]);

    expect(pending).toEqual([
      { roomId: ROOM, sortIdx: S1 },
      { roomId: ROOM, sortIdx: S2 },
    ]);
  });

  test("ignores non-delete events and deletes with no target", async () => {
    const { db, asyncDb } = freshDb();
    seedFixtures(db);

    const pending = await collectPendingDeletes(asyncDb, [
      {
        idx: 0,
        user: ALICE,
        event: { id: S1, $type: "space.roomy.message.createMessage.v0" },
      } as unknown as DecodedStreamEvent,
      {
        idx: 1,
        user: ALICE,
        // Delete with no messageId: nothing to unwind.
        event: { id: S2, $type: "space.roomy.message.deleteMessage.v0", room: ROOM },
      } as unknown as DecodedStreamEvent,
    ]);

    expect(pending).toEqual([]);
  });
});
