/**
 * updateSeen handler: the read-position write must NOT depend on a live
 * materializer for the room's space. Hydration is kicked off in the background
 * (fire-and-forget); the handler reads the already-on-disk materialisation and
 * writes the watermark synchronously. These tests seed a room + messages, then
 * call the handler with NO materializer registered for the room's space and
 * assert the read position it writes is the one the reader's unread count is
 * then derived from.
 */

import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";

import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { updateSeenHandler } from "./space.roomy.room.updateSeen.ts";
import { deriveUnreadCounts } from "../queries/readPositions.ts";

const USER = UserDid.assert("did:plc:seen-user");
const SPACE = StreamDid.assert("did:web:space.example");


interface ReadPositionRow {
  seen_up_to: string;
}

async function readPosition(roomId: string): Promise<ReadPositionRow | null> {
  return openReadStateDb()
    .query("select seen_up_to from read_positions where user_did = ? and room_id = ?")
    .get<ReadPositionRow>(USER, roomId);
}

/** The unread count that follows from the position the handler just wrote. */
async function unreadFor(roomId: string): Promise<number> {
  const row = await readPosition(roomId);
  const [n] = await deriveUnreadCounts(openSpaceDb(SPACE), [
    { roomId, seenUpTo: row?.seen_up_to ?? "" },
  ]);
  return n!;
}

let roomId: string;
let msgA: string;
let msgB: string;

beforeEach(async () => {
  closeDb();


  // In-memory singleton so the handler's internal openDb() sees this DB.
  const db = openDb({ path: ":memory:" });
  const space = db.forSpace!(SPACE);

  roomId = newUlid();
  msgA = newUlid();
  msgB = newUlid();

  // Room lives in SPACE; two messages with sort_idx "a" < "b". Materialised
  // rows live in the per-space DB.
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [msgA, SPACE, roomId, "a"],
  );
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [msgB, SPACE, roomId, "b"],
  );

  // openSpaceDbForEntity(roomId) resolves the room's space via the global
  // entity_space index — seed it so the handler finds the per-space DB.
  await db.global!().run(
    "insert into entity_space (entity_id, space_did) values (?, ?)",
    [roomId, SPACE],
  );

  // Make the background hydration hermetic: the room's space (SPACE)
  // intentionally has NO materializer registered, so the handler must rely
  // solely on the already-on-disk materialisation when writing the watermark.
});

afterEach(() => {
  closeDb();

});

describe("updateSeen", () => {
  test("no seenUpTo → marks read up to latest message, unread 0 (no space materializer)", async () => {
    await updateSeenHandler({}, { did: USER }, { roomId });

    const row = await readPosition(roomId);
    expect(row).not.toBeNull();
    expect(row?.seen_up_to).toBe("b"); // max(sort_idx)
    // An explicit watermark at the newest message leaves nothing unread.
    expect(await unreadFor(roomId)).toBe(0);
  });

  test("explicit seenUpTo → watermark at that message, unread counts the rest", async () => {
    await updateSeenHandler({}, { did: USER }, { roomId, seenUpTo: msgA });

    const row = await readPosition(roomId);
    expect(row?.seen_up_to).toBe("a"); // msgA's sort_idx
    // msgB is after the watermark, so it is the one unread message.
    expect(await unreadFor(roomId)).toBe(1);
  });

  test("reading a thread registers it as engagement (user_thread_activity)", async () => {
    const space = openDb().forSpace!(SPACE);
    const threadRoomId = newUlid();
    await space.run("insert into entities (id, stream_id) values (?, ?)", [threadRoomId, SPACE]);
    await space.run(
      "insert into comp_room (entity, label) values (?, 'space.roomy.thread')",
      [threadRoomId],
    );
    await openDb().global!().run(
      "insert into entity_space (entity_id, space_did) values (?, ?)",
      [threadRoomId, SPACE],
    );

    await updateSeenHandler({}, { did: USER }, { roomId: threadRoomId });

    const row = await openReadStateDb()
      .query(
        "select last_active_at from user_thread_activity where user_did = ? and thread_id = ?",
      )
      .get<{ last_active_at: number }>(USER, threadRoomId);
    expect(row).not.toBeNull();
    expect(row?.last_active_at).toBeGreaterThan(0);
  });

  test("reading a channel does not register thread activity", async () => {
    await updateSeenHandler({}, { did: USER }, { roomId });

    const row = await openReadStateDb()
      .query(
        "select user_did from user_thread_activity where user_did = ? and thread_id = ?",
      )
      .get<{ user_did: string }>(USER, roomId);
    expect(row).toBeNull();
  });

  test("unknown room still 404s after the hydration fallback", async () => {
    await expect(
      updateSeenHandler({}, { did: USER }, { roomId: newUlid() }),
    ).rejects.toThrow(/Room not found/);
  });
});
