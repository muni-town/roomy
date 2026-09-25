/**
 * `room_activity` projection maintenance contract.
 *
 * The projection only exists to make board reads cheap, so the tests that matter
 * are the ones that pin what would make it *wrong*: an event that moves a room's
 * latest message and is not reflected, or a replay that leaves a stale row
 * behind. Exact equality with the scan read path is asserted in
 * `queries/threadActivity.test.ts`, against the same fixtures the read path
 * already uses.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  maintainRoomActivity,
  readRoomActivityProjection,
  rebuildRoomActivity,
} from "./roomActivityProjection.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");

const SPACE = "did:web:room-activity.example";
const ROOM_A = "01ROOMAA000000000000000000";
const ROOM_B = "01ROOMBB000000000000000000";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return { db, asyncDb: toAsyncDb(db) };
}

/** A message as the materialiser leaves it: entity + content + author edge. */
function postMessage(db: Database, id: string, room: string, ts: number, did: string): void {
  db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [id, SPACE, room]);
  db.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
    [id, Buffer.from("hi"), id, ts],
  );
  db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, did]);
}

function seed(db: Database): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  // Entities before the edges that reference them (FKs are on).
  for (const room of [ROOM_A, ROOM_B]) {
    db.run("insert into entities (id, stream_id) values (?, ?)", [room, SPACE]);
    db.run("insert into comp_room (entity, label) values (?, 'space.roomy.channel')", [room]);
  }
  for (const did of [ALICE, BOB]) {
    db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  }
}

describe("room_activity projection maintenance", () => {
  test("a live createMessage merges the message into its room's row", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);
    postMessage(db, "01MSG000000000000000000001", ROOM_A, 1000, ALICE);

    const step = maintainRoomActivity(
      { $type: "space.roomy.message.createMessage.v0", id: "01MSG000000000000000000001" },
      false,
    );
    expect(step).not.toBeNull();
    await asyncDb.run(step!.sql, ...step!.params);

    const rows = (await readRoomActivityProjection(asyncDb, [ROOM_A]))!;
    expect(rows.get(ROOM_A)).toEqual({
      latestMessageId: "01MSG000000000000000000001",
      latestAt: 1000,
      authors: [{ did: ALICE, ts: 1000 }],
    });
    // Room B saw nothing, so it has no row — which is what sends a read of it
    // to the live scan rather than to an invented empty row.
    expect(await readRoomActivityProjection(asyncDb, [ROOM_B])).toBeNull();
  });

  test("a message older than the recorded latest does not displace it", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);
    await rebuildRoomActivity(asyncDb, [ROOM_A]);
    postMessage(db, "01MSG000000000000000000001", ROOM_A, 5000, ALICE);
    postMessage(db, "01MSG000000000000000000002", ROOM_A, 1000, BOB);

    for (const id of ["01MSG000000000000000000002", "01MSG000000000000000000001"]) {
      const step = maintainRoomActivity(
        { $type: "space.roomy.message.createMessage.v0", id },
        false,
      )!;
      await asyncDb.run(step.sql, ...step.params);
    }

    // The out-of-order message is a Discord-bridged message carrying an old
    // timestampOverride after a newer message arrived: the board's column is the
    // room's MAX time, so the newest message must survive it.
    const row = (await readRoomActivityProjection(asyncDb, [ROOM_A]))!.get(ROOM_A)!;
    expect(row.latestMessageId).toBe("01MSG000000000000000000001");
    expect(row.latestAt).toBe(5000);
    expect(row.authors).toEqual([
      { did: ALICE, ts: 5000 },
      { did: BOB, ts: 1000 },
    ]);
  });

  test("delete and move invalidate the rooms they change", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);
    postMessage(db, "01MSG000000000000000000001", ROOM_A, 1000, ALICE);
    await rebuildRoomActivity(asyncDb, [ROOM_A, ROOM_B]);

    const del = maintainRoomActivity(
      { $type: "space.roomy.message.deleteMessage.v0", room: ROOM_A },
      false,
    )!;
    await asyncDb.run(del.sql, ...del.params);
    expect(await readRoomActivityProjection(asyncDb, [ROOM_A])).toBeNull();

    const move = maintainRoomActivity(
      { $type: "space.roomy.message.moveMessages.v0", room: ROOM_A, toRoomId: ROOM_B },
      false,
    )!;
    await asyncDb.run(move.sql, ...move.params);
    expect(await readRoomActivityProjection(asyncDb, [ROOM_A, ROOM_B])).toBeNull();

    // A self-move invalidates the one room it names — conservative rather than
    // clever: a dropped row costs the next read its projection, never its
    // correctness.
    const self = maintainRoomActivity(
      { $type: "space.roomy.message.moveMessages.v0", room: ROOM_A, toRoomId: ROOM_A },
      false,
    );
    expect(self?.params).toEqual([ROOM_A]);
  });

  test("the same create during backfill DELETES rather than populates", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);
    postMessage(db, "01MSG000000000000000000001", ROOM_A, 1000, ALICE);

    const live = maintainRoomActivity(
      { $type: "space.roomy.message.createMessage.v0", id: "01MSG000000000000000000001" },
      false,
    )!;
    await asyncDb.run(live.sql, ...live.params);
    expect(await readRoomActivityProjection(asyncDb, [ROOM_A])).not.toBeNull();

    // Replay must INVALIDATE, not re-populate: no projection data may be
    // produced by rematerialisation, but a replayed message must not leave the
    // row describing a state the replay just changed.
    const replay = maintainRoomActivity(
      { $type: "space.roomy.message.createMessage.v0", id: "01MSG000000000000000000001" },
      true,
    )!;
    await asyncDb.run(replay.sql, ...replay.params);
    expect(await readRoomActivityProjection(asyncDb, [ROOM_A])).toBeNull();
  });

  test("events that cannot move a room's latest message produce no step", () => {
    for (const $type of [
      "space.roomy.message.editMessage.v0",
      "space.roomy.message.reorderMessage.v0",
      "space.roomy.reaction.addReaction.v0",
      "space.roomy.room.createRoom.v0",
    ]) {
      expect(maintainRoomActivity({ $type }, false)).toBeNull();
      expect(maintainRoomActivity({ $type }, true)).toBeNull();
    }
    // Malformed payloads are inert rather than producing a broken statement.
    expect(maintainRoomActivity({ $type: "space.roomy.message.createMessage.v0" }, false)).toBeNull();
    expect(
      maintainRoomActivity({ $type: "space.roomy.message.deleteMessage.v0" }, false),
    ).toBeNull();
  });
});
