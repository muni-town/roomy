/**
 * updateSeen handler: the read-position write must NOT depend on a live
 * materializer for the room's space. Hydration is kicked off in the background
 * (fire-and-forget); the handler reads the already-on-disk materialisation and
 * writes the watermark synchronously. These tests seed a room + messages, then
 * call the handler with NO materializer registered for the room's space and
 * assert the read_positions row is written correctly.
 */

import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";

import { closeDb, openDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { updateSeenHandler } from "./space.roomy.room.updateSeen.ts";

const USER = UserDid.assert("did:plc:seen-user");
const PERSONAL = StreamDid.assert("did:web:personal.example");
const SPACE = StreamDid.assert("did:web:space.example");


interface ReadPositionRow {
  seen_up_to: string;
  unread_count: number;
}

async function readPosition(roomId: string): Promise<ReadPositionRow | null> {
  return openDb()
    .query("select seen_up_to, unread_count from readstate.read_positions where user_did = ? and room_id = ?")
    .get<ReadPositionRow>(USER, roomId);
}

let roomId: string;
let msgA: string;
let msgB: string;

beforeEach(async () => {
  closeDb();

  _resetHydrationInflight();

  // In-memory singleton so the handler's internal openDb() sees this DB.
  const db = openDb({ path: ":memory:" });

  roomId = newUlid();
  msgA = newUlid();
  msgB = newUlid();

  // Room lives in SPACE; two messages with sort_idx "a" < "b".
  await db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await db.run("insert into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  await db.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [msgA, SPACE, roomId, "a"],
  );
  await db.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [msgB, SPACE, roomId, "b"],
  );

  // Make the background hydration hermetic: seed the personal-stream cache and
  // pre-warm ONLY the personal materializer with an instant fake. The room's
  // space (SPACE) intentionally has NO materializer registered.
  await db.run(
    "insert into comp_user_personal_stream (user_did, personal_stream_did, resolved_at) values (?, ?, ?)",
    [USER, PERSONAL, 0],
  );
});

afterEach(() => {
  closeDb();

  _resetHydrationInflight();
});

describe("updateSeen", () => {
  test("no seenUpTo → marks read up to latest message, unread 0 (no space materializer)", async () => {
    await updateSeenHandler({}, { did: USER }, { roomId });

    const row = await readPosition(roomId);
    expect(row).not.toBeNull();
    expect(row?.seen_up_to).toBe("b"); // max(sort_idx)
    expect(row?.unread_count).toBe(0);
  });

  test("explicit seenUpTo → watermark at that message, unread counts the rest", async () => {
    await updateSeenHandler({}, { did: USER }, { roomId, seenUpTo: msgA });

    const row = await readPosition(roomId);
    expect(row?.seen_up_to).toBe("a"); // msgA's sort_idx
    expect(row?.unread_count).toBe(1); // msgB is after the watermark
  });

  test("unknown room still 404s after the hydration fallback", async () => {
    await expect(
      updateSeenHandler({}, { did: USER }, { roomId: newUlid() }),
    ).rejects.toThrow(/Room not found/);
  });
});
