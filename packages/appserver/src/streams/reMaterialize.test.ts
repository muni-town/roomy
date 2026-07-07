/**
 * Unit tests for reMaterializeFromLocalEvents — idempotent re-materialization
 * of every stream from the local events DB on boot.
 *
 * Uses an in-memory main DB with a temp-file events DB (ATTACHed by openDb).
 * Events are seeded directly into events.stream_events, bypassing StreamManager.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encode, decode } from "@atcute/cbor";
import {
  createDefaultSpaceEvents,
  StreamDid,
  StreamIndex,
  UserDid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import { closeDb, openDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { reMaterializeFromLocalEvents } from "./reMaterialize.ts";
import { applyBatch } from "../materialization/applyBatch.ts";
import type { DbLike } from "../db/types.ts";

const ADMIN = UserDid.assert("did:plc:test-admin");
let db: DbLike;

beforeEach(async () => {
  closeDb();
  _resetHydrationInflight();
  _resetEmbedSweeper();

  // Use a unique events DB path per test so events don't leak between tests.
  const testId = Math.random().toString(36).slice(2, 8);
  process.env.EVENTS_DB_PATH = `/tmp/roomy-events-${testId}.sqlite`;

  // In-memory main DB; the worker ATTACHes the events DB as `events`.
  db = openDb({ path: ":memory:" });
});

afterEach(() => {
  closeDb();
  delete process.env.EVENTS_DB_PATH;
});

/**
 * Seed events into events.stream_events for a given stream.
 * Each event is CBOR-encoded and inserted with a sequential idx starting
 * from `startIdx` (default 0). Also pre-seeds the entities row for the
 * stream DID so FK constraints resolve (mirrors what createStream does in
 * production).
 */
async function seedEvents(
  db: DbLike,
  streamDid: StreamDid,
  events: Record<string, unknown>[],
  user: UserDid = ADMIN,
  startIdx: number = 0,
): Promise<void> {
  // Pre-seed the entity row for the stream DID (createStream does this)
  await db.run(
    "insert into entities (id, stream_id) values (?, ?) on conflict(id) do nothing",
    streamDid,
    streamDid,
  );

  for (let i = 0; i < events.length; i++) {
    const payload = encode(events[i] as Parameters<typeof encode>[0]);
    await db.run(
      "insert into events.stream_events (stream_id, idx, user, payload, signature) values (?, ?, ?, ?, x'')",
      streamDid,
      startIdx + i,
      user,
      payload,
    );
  }
}

/**
 * Generate N createRoom events with unique names. Used to create enough
 * events to span multiple chunks (CHUNK_SIZE = 500) in applyBatch.
 */
function makeRoomEvents(count: number): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      $type: "space.roomy.room.createRoom.v0",
      id: `01KWZ4VF1EROOM${String(i).padStart(7, "0")}`,
      kind: "space.roomy.channel",
      name: `room-${i}`,
    });
  }
  return events;
}

/**
 * Read and decode events from the events DB for a given stream, starting
 * from `fromIdx`. Returns DecodedStreamEvent[] ready for applyBatch.
 */
async function readDecodedEvents(
  db: DbLike,
  streamDid: StreamDid,
  fromIdx: number = 0,
): Promise<DecodedStreamEvent[]> {
  const rows = await db
    .query(
      "SELECT idx, user, payload FROM events.stream_events WHERE stream_id = ? AND idx >= ? ORDER BY idx",
    )
    .all<{ idx: number; user: string; payload: Uint8Array }>(streamDid, fromIdx);
  return rows.map((r): DecodedStreamEvent => ({
    idx: r.idx as StreamIndex,
    event: decode(r.payload) as Event,
    user: r.user as UserDid,
  }));
}

// ─── reMaterializeFromLocalEvents ────────────────────────────────────────

describe("reMaterializeFromLocalEvents", () => {
  test("idempotent re-apply", async () => {
    const streamDid = StreamDid.assert("did:web:idempotent-test.example");

    // Seed default space events (updateSpaceInfo, createRoom, updateSidebar)
    const events = createDefaultSpaceEvents({ name: "Idempotent Space" });
    await seedEvents(db, streamDid, events);

    // ── First pass ──────────────────────────────────────────────────────
    await reMaterializeFromLocalEvents(db);

    // Snapshot materialized row counts
    const entities1 = await db
      .query("select count(*) as cnt from entities")
      .get<{ cnt: number }>();
    expect(entities1!.cnt).toBeGreaterThan(0);

    const compInfo1 = await db
      .query("select count(*) as cnt from comp_info")
      .get<{ cnt: number }>();
    expect(compInfo1!.cnt).toBeGreaterThan(0);

    const compRoom1 = await db
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(compRoom1!.cnt).toBeGreaterThan(0);

    const compSpace1 = await db
      .query("select count(*) as cnt from comp_space")
      .get<{ cnt: number }>();
    // comp_space row is only created when updateSpaceInfo sets space-level
    // fields (allowPublicJoin, allowMemberInvites). Default space events
    // only set name/description, so no comp_space row is inserted.
    expect(compSpace1!.cnt).toBe(0);

    // Verify key columns are populated
    const spaceRow1 = await db
      .query("select entity, handle, sidebar_config from comp_space where entity = ?")
      .get<{ entity: string; handle: string | null; sidebar_config: string }>(streamDid);
    // No comp_space row was created, so this should be null
    expect(spaceRow1).toBeNull();
    const infoRow1 = await db
      .query("select entity, name from comp_info where entity = ?")
      .get<{ entity: string; name: string | null }>(streamDid);
    expect(infoRow1).not.toBeNull();
    expect(infoRow1!.name).toBe("Idempotent Space");

    // ── Second pass — should not change anything ──────────────────────
    await reMaterializeFromLocalEvents(db);

    const entities2 = await db
      .query("select count(*) as cnt from entities")
      .get<{ cnt: number }>();
    expect(entities2!.cnt).toBe(entities1!.cnt);

    const compInfo2 = await db
      .query("select count(*) as cnt from comp_info")
      .get<{ cnt: number }>();
    expect(compInfo2!.cnt).toBe(compInfo1!.cnt);

    const compRoom2 = await db
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(compRoom2!.cnt).toBe(compRoom1!.cnt);

    const compSpace2 = await db
      .query("select count(*) as cnt from comp_space")
      .get<{ cnt: number }>();
    expect(compSpace2!.cnt).toBe(compSpace1!.cnt);

    // Key column values unchanged
    const spaceRow2 = await db
      .query("select entity, handle, sidebar_config from comp_space where entity = ?")
      .get<{ entity: string; handle: string | null; sidebar_config: string }>(streamDid);
    // Still no comp_space row
    expect(spaceRow2).toBeNull();


    const infoRow2 = await db
      .query("select entity, name from comp_info where entity = ?")
      .get<{ entity: string; name: string | null }>(streamDid);
    expect(infoRow2!.name).toBe(infoRow1!.name);
  });

  test("empty events DB", async () => {
    // No events seeded — should be a no-op
    await reMaterializeFromLocalEvents(db);

    const entities = await db
      .query("select count(*) as cnt from entities")
      .get<{ cnt: number }>();
    expect(entities!.cnt).toBe(0);

    const compSpace = await db
      .query("select count(*) as cnt from comp_space")
      .get<{ cnt: number }>();
    expect(compSpace!.cnt).toBe(0);
  });

  test("multiple streams", async () => {
    const stream1 = StreamDid.assert("did:web:multi-one.example");
    const stream2 = StreamDid.assert("did:web:multi-two.example");

    const events1 = createDefaultSpaceEvents({ name: "Space Alpha" });
    const events2 = createDefaultSpaceEvents({ name: "Space Beta" });

    await seedEvents(db, stream1, events1);
    await seedEvents(db, stream2, events2);

    await reMaterializeFromLocalEvents(db);

    // Both streams should have entities
    const stream1Entities = await db
      .query("select count(*) as cnt from entities where stream_id = ?")
      .get<{ cnt: number }>(stream1);
    expect(stream1Entities!.cnt).toBeGreaterThan(0);

    const stream2Entities = await db
      .query("select count(*) as cnt from entities where stream_id = ?")
      .get<{ cnt: number }>(stream2);
    expect(stream2Entities!.cnt).toBeGreaterThan(0);

    // comp_space row is only created when updateSpaceInfo sets space-level
    // fields (allowPublicJoin, allowMemberInvites). Default space events
    // only set name/description, so no comp_space row is inserted.
    const stream1Space = await db
      .query("select count(*) as cnt from comp_space where entity = ?")
      .get<{ cnt: number }>(stream1);
    expect(stream1Space!.cnt).toBe(0);

    const stream2Space = await db
      .query("select count(*) as cnt from comp_space where entity = ?")
      .get<{ cnt: number }>(stream2);
    expect(stream2Space!.cnt).toBe(0);

    // Each stream's comp_info should have the correct name
    const info1 = await db
      .query("select name from comp_info where entity = ?")
      .get<{ name: string | null }>(stream1);
    expect(info1!.name).toBe("Space Alpha");

    const info2 = await db
      .query("select name from comp_info where entity = ?")
      .get<{ name: string | null }>(stream2);
    expect(info2!.name).toBe("Space Beta");
  });
  test("skips already-materialized streams on second call", async () => {
    const streamDid = StreamDid.assert("did:web:cursor-skip.example");

    const events = createDefaultSpaceEvents({ name: "Cursor Skip Space" });
    await seedEvents(db, streamDid, events);

    // First call: full replay (no cursor row → materialized_to defaults to -1)
    await reMaterializeFromLocalEvents(db);

    const entitiesAfterFirst = await db
      .query("select count(*) as cnt from entities where stream_id = ?")
      .get<{ cnt: number }>(streamDid);
    expect(entitiesAfterFirst!.cnt).toBeGreaterThan(0);

    // Cursor should now be at the latest event idx
    const cursor = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor).not.toBeNull();
    // latest event idx = events.length - 1 (0-indexed)
    expect(cursor!.materialized_to).toBe(events.length - 1);

    // Second call: cursor is current → stream is skipped, no replay
    await reMaterializeFromLocalEvents(db);

    // Row counts unchanged
    const entitiesAfterSecond = await db
      .query("select count(*) as cnt from entities where stream_id = ?")
      .get<{ cnt: number }>(streamDid);
    expect(entitiesAfterSecond!.cnt).toBe(entitiesAfterFirst!.cnt);

    // Cursor unchanged
    const cursor2 = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor2!.materialized_to).toBe(cursor!.materialized_to);
  });

  test("replays only new events after cursor on partial catch-up", async () => {
    const streamDid = StreamDid.assert("did:web:partial-catchup.example");

    const initialEvents = createDefaultSpaceEvents({ name: "Partial Space" });
    await seedEvents(db, streamDid, initialEvents);

    // First call: materialize all initial events
    await reMaterializeFromLocalEvents(db);

    const cursorAfterFirst = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursorAfterFirst!.materialized_to).toBe(initialEvents.length - 1);

    // Seed additional events (simulating events written while appserver was down)
    const extraEvents = createDefaultSpaceEvents({ name: "Extra Space" });
    await seedEvents(db, streamDid, extraEvents, ADMIN, initialEvents.length);

    // Second call: should only replay the new events (idx > cursor)
    await reMaterializeFromLocalEvents(db);

    // Cursor should advance to the new latest idx
    const cursorAfterSecond = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursorAfterSecond!.materialized_to).toBe(initialEvents.length + extraEvents.length - 1);
  });

  test("mix of caught-up and behind streams", async () => {
    const caughtUp = StreamDid.assert("did:web:caught-up.example");
    const behind = StreamDid.assert("did:web:behind.example");

    // Both streams get initial events
    const events1 = createDefaultSpaceEvents({ name: "Caught Up" });
    const events2 = createDefaultSpaceEvents({ name: "Behind" });
    await seedEvents(db, caughtUp, events1);
    await seedEvents(db, behind, events2);

    // First call: materialize both
    await reMaterializeFromLocalEvents(db);

    // Add more events to "behind" only
    const extraEvents = createDefaultSpaceEvents({ name: "Behind Extra" });
    await seedEvents(db, behind, extraEvents, ADMIN, events2.length);

    // Second call: "caughtUp" should be skipped, "behind" should replay extras
    await reMaterializeFromLocalEvents(db);

    const caughtUpCursor = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(caughtUp);
    expect(caughtUpCursor!.materialized_to).toBe(events1.length - 1);

    const behindCursor = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(behind);
    expect(behindCursor!.materialized_to).toBe(events2.length + extraEvents.length - 1);
  });
  test("cursor advances per-chunk across multi-chunk batch", async () => {
    const streamDid = StreamDid.assert("did:web:multi-chunk.example");

    // 600 events → spans 2 chunks (CHUNK_SIZE = 500)
    const events = makeRoomEvents(600);
    await seedEvents(db, streamDid, events);

    await reMaterializeFromLocalEvents(db);

    // Cursor should be at the last event idx (599)
    const cursor = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor!.materialized_to).toBe(599);

    // All 600 rooms should be materialized
    const roomCount = await db
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(roomCount!.cnt).toBe(600);

    // Second call: cursor is current → skipped
    await reMaterializeFromLocalEvents(db);
    const cursor2 = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor2!.materialized_to).toBe(599);
  });

  test("resumes from last committed chunk after interruption", async () => {
    const streamDid = StreamDid.assert("did:web:interrupted.example");

    // 1000 events → spans 2 chunks of 500 each
    const events = makeRoomEvents(1000);
    await seedEvents(db, streamDid, events);

    // Simulate a crash after the first chunk: call applyBatch directly with
    // only the first 500 events. The cursor should advance to idx 499.
    const firstBatch = await readDecodedEvents(db, streamDid, 0);
    const firstChunkEvents = firstBatch.slice(0, 500);
    await applyBatch(db, streamDid, firstChunkEvents, { isBackfill: true });

    const cursorAfterFirstChunk = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursorAfterFirstChunk!.materialized_to).toBe(499);

    // 500 rooms materialized so far
    const roomsAfterFirstChunk = await db
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(roomsAfterFirstChunk!.cnt).toBe(500);

    // Now simulate a restart: reMaterializeFromLocalEvents should see the
    // cursor at 499 and only replay events 500-999 (the second chunk).
    await reMaterializeFromLocalEvents(db);

    // Cursor should now be at 999
    const cursorAfterResume = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursorAfterResume!.materialized_to).toBe(999);

    // All 1000 rooms should now be materialized
    const roomsAfterResume = await db
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(roomsAfterResume!.cnt).toBe(1000);
  });
  test("cursor advances even when all events in batch have apply errors", async () => {
    const streamDid = StreamDid.assert("did:web:all-errors.example");

    // Create events with an invalid defaultAccess that will fail the CHECK
    // constraint on comp_room (default_access must be in ('readwrite',
    // 'read', 'none')). The materializer will produce SQL, but execution
    // will fail — simulating the 100% apply-error streams from the log.
    const badEvents: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      badEvents.push({
        $type: "space.roomy.room.createRoom.v0",
        id: `01KWZ4VF1EBAD${String(i).padStart(7, "0")}`,
        kind: "space.roomy.channel",
        name: `bad-room-${i}`,
        defaultAccess: "bogus",
      });
    }
    await seedEvents(db, streamDid, badEvents);

    // applyBatch should process the events (with errors) and still advance
    // the cursor — this is the key fix for the infinite-retry loop.
    const decoded = await readDecodedEvents(db, streamDid, 0);
    await applyBatch(db, streamDid, decoded, { isBackfill: true });

    // Cursor must have advanced past the failed events
    const cursor = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor).not.toBeNull();
    expect(cursor!.materialized_to).toBe(2); // last event idx (0-indexed)

    // reMaterializeFromLocalEvents should skip this stream (cursor is current)
    await reMaterializeFromLocalEvents(db);
    const cursor2 = await db
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor2!.materialized_to).toBe(2);
  });
});
