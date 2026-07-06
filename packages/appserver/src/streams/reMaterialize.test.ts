/**
 * Unit tests for reMaterializeFromLocalEvents — idempotent re-materialization
 * of every stream from the local events DB on boot.
 *
 * Uses an in-memory main DB with a temp-file events DB (ATTACHed by openDb).
 * Events are seeded directly into events.stream_events, bypassing StreamManager.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encode } from "@atcute/cbor";
import {
  createDefaultSpaceEvents,
  StreamDid,
  UserDid,
} from "@roomy-space/sdk";
import { closeDb, openDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { reMaterializeFromLocalEvents } from "./reMaterialize.ts";
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
 * Each event is CBOR-encoded and inserted with a sequential idx.
 * Also pre-seeds the entities row for the stream DID so FK constraints
 * resolve (mirrors what createStream does in production).
 */
async function seedEvents(
  db: DbLike,
  streamDid: StreamDid,
  events: Record<string, unknown>[],
  user: UserDid = ADMIN,
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
      i,
      user,
      payload,
    );
  }
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
});
