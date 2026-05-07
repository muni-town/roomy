import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";

import { openDb } from "../db/db.ts";
import { applyBatch } from "./applyBatch.ts";

const STREAM = StreamDid.assert("did:web:test-stream.example");
const USER = UserDid.assert("did:plc:test-user");

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

function seedSpace(db: Database, streamDid: StreamDid): void {
  // The space entity + comp_space row are normally created by the
  // PersonalJoinSpace materialiser on the user's personal stream. Tests for
  // the apply machinery seed them directly so we can verify backfilled_to.
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    streamDid,
    streamDid,
  ]);
  db.run("insert into comp_space (entity) values (?)", [streamDid]);
}

function decoded(event: Event, idx: number): DecodedStreamEvent {
  return { event, idx: idx as StreamIndex, user: USER };
}

function createRoomEvent(name: string): Event {
  return {
    $type: "space.roomy.room.createRoom.v0",
    id: newUlid(),
    kind: "space.roomy.channel",
    name,
  } as unknown as Event;
}

describe("applyBatch", () => {
  test("applies a single event and advances backfilled_to", () => {
    const db = freshDb();
    seedSpace(db, STREAM);

    const event = createRoomEvent("general");
    const stats = applyBatch(db, STREAM, [decoded(event, 5)], {
      isBackfill: true,
    });

    expect(stats.applied).toBe(1);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    const room = db
      .query<{ entity: string; label: string }, [string]>(
        "select entity, label from comp_room where entity = ?",
      )
      .get(event.id);
    expect(room?.label).toBe("space.roomy.channel");

    const cursor = db
      .query<{ backfilled_to: number }, [string]>(
        "select backfilled_to from comp_space where entity = ?",
      )
      .get(STREAM);
    expect(cursor?.backfilled_to).toBe(5);
  });

  test("counts materialiser errors without aborting the batch", () => {
    const db = freshDb();
    seedSpace(db, STREAM);

    const ok = createRoomEvent("ok");
    const bad = {
      $type: "space.roomy.this.does.not.exist.v0",
      id: newUlid(),
    } as unknown as Event;
    const ok2 = createRoomEvent("ok2");

    const stats = applyBatch(
      db,
      STREAM,
      [decoded(ok, 1), decoded(bad, 2), decoded(ok2, 3)],
      { isBackfill: true },
    );

    expect(stats.applied).toBe(2);
    expect(stats.materializerErrors).toBe(1);
    expect(stats.applyErrors).toBe(0);
    expect(stats.failed).toHaveLength(1);
    expect(stats.failed[0]?.reason).toBe("materializer");

    expect(
      db
        .query<{ count: number }, []>("select count(*) as count from comp_room")
        .get()?.count,
    ).toBe(2);

    // Cursor advances to the highest idx in the batch even though one event
    // failed — the failure is tracked, but we have no reason to stay stuck
    // on a permanently-broken event.
    expect(
      db
        .query<{ backfilled_to: number }, [string]>(
          "select backfilled_to from comp_space where entity = ?",
        )
        .get(STREAM)?.backfilled_to,
    ).toBe(3);
  });

  test("backfilled_to never moves backwards", () => {
    const db = freshDb();
    seedSpace(db, STREAM);

    applyBatch(db, STREAM, [decoded(createRoomEvent("a"), 10)], {
      isBackfill: true,
    });
    applyBatch(db, STREAM, [decoded(createRoomEvent("b"), 3)], {
      isBackfill: true,
    });

    const cursor = db
      .query<{ backfilled_to: number }, [string]>(
        "select backfilled_to from comp_space where entity = ?",
      )
      .get(STREAM);
    expect(cursor?.backfilled_to).toBe(10);
  });

  test("empty batch returns zero stats and does not touch cursor", () => {
    const db = freshDb();
    seedSpace(db, STREAM);
    db.run("update comp_space set backfilled_to = 7 where entity = ?", [
      STREAM,
    ]);

    const stats = applyBatch(db, STREAM, [], { isBackfill: false });

    expect(stats.applied).toBe(0);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    expect(
      db
        .query<{ backfilled_to: number }, [string]>(
          "select backfilled_to from comp_space where entity = ?",
        )
        .get(STREAM)?.backfilled_to,
    ).toBe(7);
  });

  test("a single bad SQL error rolls back only that event's savepoint", () => {
    const db = freshDb();
    seedSpace(db, STREAM);

    const goodA = createRoomEvent("a");
    const goodB = createRoomEvent("b");

    // Drop comp_room mid-batch by hand-applying the first event, then
    // breaking the schema so the second one's INSERT into comp_room fails.
    // We do this via two batches: first batch applies normally, then we
    // break a constraint and fire a second batch.
    applyBatch(db, STREAM, [decoded(goodA, 1)], { isBackfill: true });

    // Force a NOT NULL violation by removing comp_room's `entity` column path —
    // simplest deterministic break is a duplicate-pkey: we re-use goodA's id.
    const dup = {
      $type: "space.roomy.room.createRoom.v0",
      id: goodA.id, // same ULID → entities row already exists, comp_room row exists
      kind: "space.roomy.channel",
      name: "dup",
    } as unknown as Event;

    // (this should NOT throw — comp_room insert has `on conflict do nothing`)
    // So we need a different break: violate the default_access CHECK.
    const broken = {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.channel",
      defaultAccess: "bogus", // not in ('readwrite','read','none')
      name: "broken",
    } as unknown as Event;

    const stats = applyBatch(
      db,
      STREAM,
      [decoded(dup, 2), decoded(broken, 3), decoded(goodB, 4)],
      { isBackfill: true },
    );

    // dup is a no-op (on conflict do nothing), broken should fail apply,
    // goodB should still apply.
    expect(stats.applyErrors).toBeGreaterThanOrEqual(1);
    expect(stats.applied).toBeGreaterThanOrEqual(1);
    expect(
      db
        .query<{ name: string | null }, [string]>(
          "select name from comp_info where entity = ?",
        )
        .get(goodB.id)?.name,
    ).toBe("b");

    // The "broken" event must NOT have left an entities row behind — its
    // savepoint should have rolled back.
    expect(
      db
        .query<{ count: number }, [string]>(
          "select count(*) as count from entities where id = ?",
        )
        .get(broken.id)?.count,
    ).toBe(0);
  });
});
