/**
 * Unit tests for reMaterializeFromLocalEvents — idempotent re-materialization
 * of every stream from the local events DB on boot.
 *
 * `openDb()` returns the EVENT-LOG DB (stream_events / stream_state).
 * Materialised rows (entities, comp_*, materialization_cursor) live in the
 * per-space DBs, reached via `db.forSpace(streamDid)`. Events are seeded
 * directly into the event-log `stream_events`, bypassing StreamManager.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { encode, decode } from "@atcute/cbor";
import {
  createDefaultSpaceEvents,
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import { closeDb, openDb } from "../db/db.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { reMaterializeFromLocalEvents } from "./reMaterialize.ts";
import { applyBatch, NO_KIND } from "../materialization/applyBatch.ts";
import { _setLokiSink } from "../log.ts";
import type { DbLike } from "../db/types.ts";

const ADMIN = UserDid.assert("did:plc:test-admin");
let db: DbLike;

beforeEach(async () => {
  closeDb();
  _resetEmbedSweeper();

  // In-memory event-log DB; derived DBs (per-space/global/readstate) are
  // also in-memory. `db` is the event-log handle.
  db = openDb({ path: ":memory:" });
});

afterEach(() => {
  closeDb();
});

/**
 * Seed events into the event-log `stream_events` for a given stream.
 * Each event is CBOR-encoded and inserted with a sequential idx starting
 * from `startIdx` (default 0). The event-log DB has no FK to `entities`, so
 * no pre-seeding is needed.
 */
async function seedEvents(
  db: DbLike,
  streamDid: StreamDid,
  events: Record<string, unknown>[],
  user: UserDid = ADMIN,
  startIdx: number = 0,
): Promise<void> {
  for (let i = 0; i < events.length; i++) {
    const payload = encode(events[i] as Parameters<typeof encode>[0]);
    // The log's server-observed clocks: a seeded row models one this server
    // accepted just now, which is what the ordering key reads.
    const receivedAt = Date.now();
    await db.run(
      "insert into stream_events (stream_id, idx, user, payload, signature, created_at, received_at) values (?, ?, ?, ?, x'', ?, ?)",
      streamDid,
      startIdx + i,
      user,
      payload,
      receivedAt,
      receivedAt,
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
 * Capture the records this replay emits through the logger's own Loki sink —
 * the same record an operator reads in Grafana. The level is raised to `debug`
 * for the duration, because a record below the threshold is dropped before
 * either sink sees it; `restore()` puts the level back so no test leaks state
 * into the next.
 */
function captureLogs() {
  const records: Record<string, unknown>[] = [];
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  _setLokiSink({
    push: (r) => {
      const parsed: unknown = JSON.parse(r.line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    },
    flush: async () => {},
    stop: () => {},
    stats: () => ({ queued: 0, sent: 0, dropped: 0, failed: 0 }),
  });
  return {
    /** The records at `level` whose message contains `msg`. */
    record(level: string, msg: string): Record<string, unknown>[] {
      return records.filter((r) => {
        const message: unknown = r.msg;
        return (
          r.level === level &&
          typeof message === "string" &&
          message.includes(msg)
        );
      });
    },
    restore(): void {
      _setLokiSink(null);
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    },
  };
}

/** The keys of a logged count map, without trusting its shape. */
function loggedKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.keys(value);
}

/**
 * Read and decode events from the event-log DB for a given stream, starting
 * from `fromIdx`. Returns DecodedStreamEvent[] ready for applyBatch.
 */
async function readDecodedEvents(
  db: DbLike,
  streamDid: StreamDid,
  fromIdx: number = 0,
): Promise<DecodedStreamEvent[]> {
  const rows = await db
    .query(
      "SELECT idx, user, payload FROM stream_events WHERE stream_id = ? AND idx >= ? ORDER BY idx",
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
    const space = db.forSpace!(streamDid);

    // Seed default space events (updateSpaceInfo, createRoom, updateSidebar)
    const events = createDefaultSpaceEvents({ name: "Idempotent Space" });
    await seedEvents(db, streamDid, events);

    // ── First pass ──────────────────────────────────────────────────────
    await reMaterializeFromLocalEvents(db);

    // Snapshot materialized row counts (per-space DB)
    const entities1 = await space
      .query("select count(*) as cnt from entities")
      .get<{ cnt: number }>();
    expect(entities1!.cnt).toBeGreaterThan(0);

    const compInfo1 = await space
      .query("select count(*) as cnt from comp_info")
      .get<{ cnt: number }>();
    expect(compInfo1!.cnt).toBeGreaterThan(0);

    const compRoom1 = await space
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(compRoom1!.cnt).toBeGreaterThan(0);

    const compSpace1 = await space
      .query("select count(*) as cnt from comp_space")
      .get<{ cnt: number }>();
    // updateSpaceInfo always ensures a comp_space row exists (even with
    // only name/description set) so getMetadata doesn't 404 on spaces
    // whose only materialization comes from their own stream events.
    expect(compSpace1!.cnt).toBe(1);

    // Verify key columns are populated
    const spaceRow1 = await space
      .query("select entity, sidebar_config from comp_space where entity = ?")
      .get<{ entity: string; sidebar_config: string }>(streamDid);
    expect(spaceRow1).not.toBeNull();
    expect(spaceRow1!.entity).toBe(streamDid);
    const infoRow1 = await space
      .query("select entity, name from comp_info where entity = ?")
      .get<{ entity: string; name: string | null }>(streamDid);
    expect(infoRow1).not.toBeNull();
    expect(infoRow1!.name).toBe("Idempotent Space");

    // ── Second pass — should not change anything ──────────────────────
    await reMaterializeFromLocalEvents(db);

    const entities2 = await space
      .query("select count(*) as cnt from entities")
      .get<{ cnt: number }>();
    expect(entities2!.cnt).toBe(entities1!.cnt);

    const compInfo2 = await space
      .query("select count(*) as cnt from comp_info")
      .get<{ cnt: number }>();
    expect(compInfo2!.cnt).toBe(compInfo1!.cnt);

    const compRoom2 = await space
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(compRoom2!.cnt).toBe(compRoom1!.cnt);

    const compSpace2 = await space
      .query("select count(*) as cnt from comp_space")
      .get<{ cnt: number }>();
    expect(compSpace2!.cnt).toBe(compSpace1!.cnt);

    // Key column values unchanged
    const spaceRow2 = await space
      .query("select entity, sidebar_config from comp_space where entity = ?")
      .get<{ entity: string; sidebar_config: string }>(streamDid);
    expect(spaceRow2).not.toBeNull();
    expect(spaceRow2!.entity).toBe(streamDid);

    const infoRow2 = await space
      .query("select entity, name from comp_info where entity = ?")
      .get<{ entity: string; name: string | null }>(streamDid);
    expect(infoRow2!.name).toBe(infoRow1!.name);
  }, { timeout: 30_000 });

  test("repairs global membership when space cursors are already current", async () => {
    const streamDid = StreamDid.assert("did:web:global-membership-repair.example");
    const member = UserDid.assert("did:plc:global-membership-member");
    const events = createDefaultSpaceEvents({ name: "Membership Repair" });
    await seedEvents(db, streamDid, events);
    await seedEvents(
      db,
      streamDid,
      [
        {
          $type: "space.roomy.space.joinSpace.v0",
          id: newUlid(),
        },
      ],
      member,
      events.length,
    );

    await reMaterializeFromLocalEvents(db);

    const globalDb = db.global!();
    await globalDb.run(
      "delete from edges where head = ? and tail = ? and label = 'joinedSpace'",
      member,
      streamDid,
    );
    await globalDb.run(
      "insert into edges (head, tail, label) values (?, ?, 'leftSpace')",
      member,
      streamDid,
    );
    // Simulate an in-progress v6 migration (a DB that was mid-upgrade when
    // the v7 bump landed): fresh DBs only stamp the current version, so the
    // pending v6 marker must be created explicitly. The registered v6 task
    // must still run and reconstruct membership.
    await globalDb.run(
      "insert or ignore into global_schema_migrations (version, completed_at) values ('6', null)",
    );

    // The per-space cursor is current, so no events are replayed. The pending
    // global migration must still reconstruct membership from the retained
    // member edge, then mark itself complete.
    await reMaterializeFromLocalEvents(db);

    const joined = await globalDb
      .query(
        "select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'",
      )
      .get<{ n: number }>(member, streamDid);
    const left = await globalDb
      .query(
        "select 1 as n from edges where head = ? and tail = ? and label = 'leftSpace'",
      )
      .get<{ n: number }>(member, streamDid);
    const migration = await globalDb
      .query(
        "select completed_at from global_schema_migrations where version = '6'",
      )
      .get<{ completed_at: number | null }>();
    expect(joined?.n).toBe(1);
    expect(left).toBeNull();
    expect(migration?.completed_at).not.toBeNull();
  }, { timeout: 30_000 });

  test("completed global migrations do not run again", async () => {
    const streamDid = StreamDid.assert("did:web:global-migration-once.example");
    const member = UserDid.assert("did:plc:global-migration-once-member");
    const events = createDefaultSpaceEvents({ name: "Migration Once" });
    await seedEvents(db, streamDid, events);
    await seedEvents(
      db,
      streamDid,
      [{ $type: "space.roomy.space.joinSpace.v0", id: newUlid() }],
      member,
      events.length,
    );
    await reMaterializeFromLocalEvents(db);

    const globalDb = db.global!();
    await globalDb.run(
      "delete from edges where head = ? and tail = ? and label = 'joinedSpace'",
      member,
      streamDid,
    );
    await reMaterializeFromLocalEvents(db);

    const joined = await globalDb
      .query(
        "select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'",
      )
      .get<{ n: number }>(member, streamDid);
    expect(joined).toBeNull();
  }, { timeout: 30_000 });

  test("empty events DB", async () => {
    // No events seeded — should be a no-op
    await reMaterializeFromLocalEvents(db);

    // No streams in the event-log DB → nothing materialized anywhere.
    const streams = await db
      .query("select count(*) as cnt from stream_events")
      .get<{ cnt: number }>();
    expect(streams!.cnt).toBe(0);
  }, { timeout: 30_000 });

  test("multiple streams", async () => {
    const stream1 = StreamDid.assert("did:web:multi-one.example");
    const stream2 = StreamDid.assert("did:web:multi-two.example");
    const space1 = db.forSpace!(stream1);
    const space2 = db.forSpace!(stream2);

    const events1 = createDefaultSpaceEvents({ name: "Space Alpha" });
    const events2 = createDefaultSpaceEvents({ name: "Space Beta" });

    await seedEvents(db, stream1, events1);
    await seedEvents(db, stream2, events2);

    await reMaterializeFromLocalEvents(db);

    // Both streams should have entities (in their own per-space DBs)
    const stream1Entities = await space1
      .query("select count(*) as cnt from entities where stream_id = ?")
      .get<{ cnt: number }>(stream1);
    expect(stream1Entities!.cnt).toBeGreaterThan(0);

    const stream2Entities = await space2
      .query("select count(*) as cnt from entities where stream_id = ?")
      .get<{ cnt: number }>(stream2);
    expect(stream2Entities!.cnt).toBeGreaterThan(0);

    // updateSpaceInfo always ensures a comp_space row exists for each
    // space (see idempotent re-apply test), so both streams get one.
    const stream1Space = await space1
      .query("select count(*) as cnt from comp_space where entity = ?")
      .get<{ cnt: number }>(stream1);
    expect(stream1Space!.cnt).toBe(1);

    const stream2Space = await space2
      .query("select count(*) as cnt from comp_space where entity = ?")
      .get<{ cnt: number }>(stream2);
    expect(stream2Space!.cnt).toBe(1);

    // Each stream's comp_info should have the correct name
    const info1 = await space1
      .query("select name from comp_info where entity = ?")
      .get<{ name: string | null }>(stream1);
    expect(info1!.name).toBe("Space Alpha");

    const info2 = await space2
      .query("select name from comp_info where entity = ?")
      .get<{ name: string | null }>(stream2);
    expect(info2!.name).toBe("Space Beta");
  }, { timeout: 30_000 });
  test("skips already-materialized streams on second call", async () => {
    const streamDid = StreamDid.assert("did:web:cursor-skip.example");
    const space = db.forSpace!(streamDid);

    const events = createDefaultSpaceEvents({ name: "Cursor Skip Space" });
    await seedEvents(db, streamDid, events);

    // First call: full replay (no cursor row → materialized_to defaults to -1)
    await reMaterializeFromLocalEvents(db);

    const entitiesAfterFirst = await space
      .query("select count(*) as cnt from entities where stream_id = ?")
      .get<{ cnt: number }>(streamDid);
    expect(entitiesAfterFirst!.cnt).toBeGreaterThan(0);

    // Cursor should now be at the latest event idx
    const cursor = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor).not.toBeNull();
    // latest event idx = events.length - 1 (0-indexed)
    expect(cursor!.materialized_to).toBe(events.length - 1);

    // Second call: cursor is current → stream is skipped, no replay
    await reMaterializeFromLocalEvents(db);

    // Row counts unchanged
    const entitiesAfterSecond = await space
      .query("select count(*) as cnt from entities where stream_id = ?")
      .get<{ cnt: number }>(streamDid);
    expect(entitiesAfterSecond!.cnt).toBe(entitiesAfterFirst!.cnt);

    // Cursor unchanged
    const cursor2 = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor2!.materialized_to).toBe(cursor!.materialized_to);
  }, { timeout: 30_000 });

  test("replays only new events after cursor on partial catch-up", async () => {
    const streamDid = StreamDid.assert("did:web:partial-catchup.example");
    const space = db.forSpace!(streamDid);

    const initialEvents = createDefaultSpaceEvents({ name: "Partial Space" });
    await seedEvents(db, streamDid, initialEvents);

    // First call: materialize all initial events
    await reMaterializeFromLocalEvents(db);

    const cursorAfterFirst = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursorAfterFirst!.materialized_to).toBe(initialEvents.length - 1);

    // Seed additional events (simulating events written while appserver was down)
    const extraEvents = createDefaultSpaceEvents({ name: "Extra Space" });
    await seedEvents(db, streamDid, extraEvents, ADMIN, initialEvents.length);

    // Second call: should only replay the new events (idx > cursor)
    await reMaterializeFromLocalEvents(db);

    // Cursor should advance to the new latest idx
    const cursorAfterSecond = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursorAfterSecond!.materialized_to).toBe(initialEvents.length + extraEvents.length - 1);
  }, { timeout: 30_000 });

  test("mix of caught-up and behind streams", async () => {
    const caughtUp = StreamDid.assert("did:web:caught-up.example");
    const behind = StreamDid.assert("did:web:behind.example");
    const caughtUpSpace = db.forSpace!(caughtUp);
    const behindSpace = db.forSpace!(behind);

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

    const caughtUpCursor = await caughtUpSpace
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(caughtUp);
    expect(caughtUpCursor!.materialized_to).toBe(events1.length - 1);

    const behindCursor = await behindSpace
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(behind);
    expect(behindCursor!.materialized_to).toBe(events2.length + extraEvents.length - 1);
  }, { timeout: 30_000 });
  test("cursor advances per-chunk across multi-chunk batch", async () => {
    const streamDid = StreamDid.assert("did:web:multi-chunk.example");
    const space = db.forSpace!(streamDid);

    // 600 events → spans 2 chunks (CHUNK_SIZE = 500)
    const events = makeRoomEvents(600);
    await seedEvents(db, streamDid, events);

    await reMaterializeFromLocalEvents(db);

    // Cursor should be at the last event idx (599)
    const cursor = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor!.materialized_to).toBe(599);

    // All 600 rooms should be materialized
    const roomCount = await space
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(roomCount!.cnt).toBe(600);

    // Second call: cursor is current → skipped
    await reMaterializeFromLocalEvents(db);
    const cursor2 = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor2!.materialized_to).toBe(599);
  }, { timeout: 30_000 });

  test("resumes from last committed chunk after interruption", async () => {
    const streamDid = StreamDid.assert("did:web:interrupted.example");
    const space = db.forSpace!(streamDid);

    // 1000 events → spans 2 chunks of 500 each
    const events = makeRoomEvents(1000);
    await seedEvents(db, streamDid, events);

    // Simulate a crash after the first chunk: call applyBatch directly with
    // only the first 500 events. The cursor should advance to idx 499.
    const firstBatch = await readDecodedEvents(db, streamDid, 0);
    const firstChunkEvents = firstBatch.slice(0, 500);
    await applyBatch(space, streamDid, firstChunkEvents, { isBackfill: true }, db.global?.());

    const cursorAfterFirstChunk = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursorAfterFirstChunk!.materialized_to).toBe(499);

    // 500 rooms materialized so far
    const roomsAfterFirstChunk = await space
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(roomsAfterFirstChunk!.cnt).toBe(500);

    // Now simulate a restart: reMaterializeFromLocalEvents should see the
    // cursor at 499 and only replay events 500-999 (the second chunk).
    await reMaterializeFromLocalEvents(db);

    // Cursor should now be at 999
    const cursorAfterResume = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursorAfterResume!.materialized_to).toBe(999);

    // All 1000 rooms should now be materialized
    const roomsAfterResume = await space
      .query("select count(*) as cnt from comp_room")
      .get<{ cnt: number }>();
    expect(roomsAfterResume!.cnt).toBe(1000);
  }, { timeout: 30_000 });
  test("cursor advances even when all events in batch have apply errors", async () => {
    const streamDid = StreamDid.assert("did:web:all-errors.example");
    const space = db.forSpace!(streamDid);

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

    // applyBatch must process the events (with errors) and still advance
    // the cursor: a failed event that does not advance the cursor is retried
    // forever by the next replay.
    const decoded = await readDecodedEvents(db, streamDid, 0);
    await applyBatch(space, streamDid, decoded, { isBackfill: true }, db.global?.());

    // Cursor must have advanced past the failed events
    const cursor = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor).not.toBeNull();
    expect(cursor!.materialized_to).toBe(2); // last event idx (0-indexed)

    // reMaterializeFromLocalEvents should skip this stream (cursor is current)
    await reMaterializeFromLocalEvents(db);
    const cursor2 = await space
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor2!.materialized_to).toBe(2);
  }, { timeout: 30_000 });

  test("backfills the global entity_space index for materialized rooms", async () => {
    const streamDid = StreamDid.assert("did:web:entity-space-backfill.example");
    const roomId = newUlid();
    await seedEvents(db, streamDid, [
      {
        $type: "space.roomy.room.createRoom.v0",
        id: roomId,
        kind: "space.roomy.channel",
        name: "general",
      },
    ]);

    await reMaterializeFromLocalEvents(db);

    // The room entity must be resolvable via the global entity_space index
    // (openSpaceDbForEntity reads this to find the owning space).
    const row = await db
      .global!()
      .query("select space_did from entity_space where entity_id = ?")
      .get<{ space_did: string }>(roomId);
    expect(row?.space_did).toBe(streamDid);
  }, { timeout: 30_000 });

  test("re-materializes streams concurrently, bounded by the concurrency cap", async () => {
    // With a pool of N workers available, boot rematerialization runs several
    // streams at once (different spaces land on different pool workers)
    // rather than strictly one at a time — but never more than the
    // `concurrency` cap, keeping memory bounded. Each stream's replay commits
    // its chunk in one `db.transaction()`, so wrapping that call measures how
    // many streams are being replayed at the same time.
    const streamCount = 4;
    const streams = Array.from({ length: streamCount }, (_, i) =>
      StreamDid.assert(`did:web:concurrent-${i}.example`),
    );

    let active = 0;
    let maxActive = 0;
    // Resolved once two streams are replaying at once, so the measurement
    // never depends on how long a replay takes: the first two reach the gate
    // together, and only then does either continue.
    const { promise: twoReplaying, resolve: twoReplayingReached } =
      Promise.withResolvers<void>();
    const probeDb: DbLike = new Proxy(db, {
      get(target, prop) {
        if (prop === "forSpace") {
          return (spaceDid: string) =>
            new Proxy(target.forSpace!(spaceDid), {
              get(handle, member) {
                if (member === "transaction") {
                  return async (
                    steps: Parameters<DbLike["transaction"]>[0],
                  ) => {
                    active++;
                    maxActive = Math.max(maxActive, active);
                    if (active === 2) twoReplayingReached();
                    await twoReplaying;
                    try {
                      return await handle.transaction(steps);
                    } finally {
                      active--;
                    }
                  };
                }
                const value = Reflect.get(handle, member) as unknown;
                return typeof value === "function"
                  ? value.bind(handle)
                  : value;
              },
            });
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    for (let i = 0; i < streamCount; i++) {
      const author = UserDid.assert(`did:plc:conc-author-${i}`);
      await seedEvents(db, streams[i]!, [
        {
          $type: "space.roomy.space.joinSpace.v0",
          id: newUlid(),
        },
      ], author);
    }

    await reMaterializeFromLocalEvents(probeDb, 2);

    // All streams were materialized.
    for (const s of streams) {
      const cnt = await db
        .forSpace!(s)
        .query("select count(*) as cnt from entities where stream_id = ?")
        .get<{ cnt: number }>(s);
      expect(cnt!.cnt).toBeGreaterThan(0);
    }

    // Exactly 2 stream replays were in flight at once — proving parallel
    // stream replay AND that the cap (not the pool) bounded the concurrency.
    expect(maxActive).toBeGreaterThanOrEqual(2);
    expect(maxActive).toBeLessThanOrEqual(2);
  }, { timeout: 30_000 });

  test("reports skipped entries by kind and does not count the stream as succeeded", async () => {
    const streamDid = StreamDid.assert("did:web:skips.example");
    const space = db.forSpace!(streamDid);
    const legacyId = newUlid();
    const unregistered = "space.roomy.this.does.not.exist.v0";

    await seedEvents(db, streamDid, [
      // Applies.
      {
        $type: "space.roomy.room.createRoom.v0",
        id: newUlid(),
        kind: "space.roomy.channel",
        name: "general",
      },
      // Decodes to a map with no `$type`: a legacy/foreign event encoding.
      { id: legacyId, name: "legacy-room" },
      // Names a kind this build cannot materialise.
      { $type: unregistered, id: newUlid() },
    ]);

    const logs = captureLogs();
    try {
      await reMaterializeFromLocalEvents(db);
    } finally {
      logs.restore();
    }

    // The undecodable payload is reported where its size is known.
    const undecodable = logs.record(
      "warn",
      "event skipped: payload decodes with no $type",
    );
    expect(undecodable).toHaveLength(1);
    expect(undecodable[0]?.eventId).toBe(legacyId);
    expect(typeof undecodable[0]?.payloadBytes).toBe("number");
    expect(undecodable[0]?.payloadBytes).toBeGreaterThan(0);

    // The per-stream line names every distinct kind it skipped.
    const streamDone = logs.record("warn", "stream-done");
    expect(streamDone).toHaveLength(1);
    expect(streamDone[0]?.applied).toBe(1);
    expect(streamDone[0]?.skipped).toBe(2);
    expect(loggedKeys(streamDone[0]?.skippedKinds).sort()).toEqual(
      [NO_KIND, unregistered].sort(),
    );

    // The run summary: the stream replayed, but it did not succeed.
    const complete = logs.record("warn", "complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({
      succeeded: 0,
      incomplete: 1,
      failed: 0,
      skipped: 2,
      skippedKinds: { [NO_KIND]: 1, [unregistered]: 1 },
    });

    // Cursor policy is unchanged: the entries nothing could read do not hold
    // the stream back.
    const cursor = await space
      .query(
        "select materialized_to from materialization_cursor where stream_id = ?",
      )
      .get<{ materialized_to: number }>(streamDid);
    expect(cursor?.materialized_to).toBe(2);
  }, { timeout: 30_000 });

  test("a boot replaying only legacy payloads completes, naming the kind", async () => {
    const streamDid = StreamDid.assert("did:web:all-legacy.example");

    await seedEvents(db, streamDid, [
      { id: newUlid(), name: "legacy-a" },
      { id: newUlid(), name: "legacy-b" },
    ]);

    const logs = captureLogs();
    try {
      await reMaterializeFromLocalEvents(db);
    } finally {
      logs.restore();
    }

    // One warn per undecodable payload, plus the per-stream and run summaries.
    expect(
      logs.record("warn", "event skipped: payload decodes with no $type"),
    ).toHaveLength(2);

    const complete = logs.record("warn", "complete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({
      succeeded: 0,
      incomplete: 1,
      failed: 0,
      skipped: 2,
      skippedKinds: { [NO_KIND]: 2 },
    });
  }, { timeout: 30_000 });

});
