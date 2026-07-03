import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type EventCallback,
  type Event,
} from "@roomy-space/sdk";

import { toAsyncDb } from "../db/syncAdapter.ts";
import {
  SpaceMaterializer,
  readBackfilledTo,
  type ConnectedSpaceLike,
} from "./SpaceMaterializer.ts";
import type { DbLike } from "../db/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

const STREAM = StreamDid.assert("did:web:fake-stream.example");
const USER = UserDid.assert("did:plc:fake-user");

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
}

function seedSpace(db: Database, streamDid: StreamDid): void {
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

/**
 * Hand-rolled fake that satisfies `ConnectedSpaceLike`. Captures the
 * subscribe args so tests can drive event delivery deterministically.
 */
class FakeConnectedSpace {
  readonly streamDid: StreamDid;
  callback: EventCallback | null = null;
  start: StreamIndex | null = null;

  private resolveBackfill!: (id: ReturnType<typeof newUlid>) => void;
  readonly backfillPromise: Promise<ReturnType<typeof newUlid>>;

  constructor(streamDid: StreamDid) {
    this.streamDid = streamDid;
    this.backfillPromise = new Promise((resolve) => {
      this.resolveBackfill = resolve;
    });
  }

  // Matches ConnectedSpace.subscribe's signature loosely enough for our use.
  subscribe(callback: EventCallback, start: StreamIndex) {
    this.callback = callback;
    this.start = start;
    return this.backfillPromise;
  }

  unsubscribe() {
    return Promise.resolve();
  }

  /** Test driver: deliver a batch through the registered callback. */
  emit(events: DecodedStreamEvent[], opts: { isBackfill: boolean }) {
    if (!this.callback) throw new Error("subscribe not called");
    this.callback(events, {
      isBackfill: opts.isBackfill,
      streamDid: this.streamDid,
      batchId: newUlid(),
    });
  }

  finishBackfill() {
    this.resolveBackfill(newUlid());
  }
}

function withFake(streamDid: StreamDid): {
  fake: FakeConnectedSpace;
  getConnectedSpace: (s: StreamDid) => Promise<ConnectedSpaceLike>;
} {
  const fake = new FakeConnectedSpace(streamDid);
  return { fake, getConnectedSpace: async (s) => {
    if (s !== streamDid) throw new Error(`unexpected stream ${s}`);
    return fake;
  } };
}

describe("SpaceMaterializer.start", () => {
  test("subscribes from cursor + 1 and applies events through applyBatch", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    db.run("update comp_space set backfilled_to = 7 where entity = ?", [
      STREAM,
    ]);

    const { fake, getConnectedSpace } = withFake(STREAM);
    const mat = await SpaceMaterializer.start({
      streamDid: STREAM,
      db: asyncDb,
      getConnectedSpace,
    });

    expect(fake.start).toBe(8 as StreamIndex);

    const room = createRoomEvent("general");
    fake.emit([decoded(room, 8)], { isBackfill: true });
    await mat.drain();

    expect(mat.getStats().applied).toBe(1);
    expect(mat.getStats().batches).toBe(1);
    expect(
      (await asyncDb
        .query("select count(*) as count from comp_room where entity = ?")
        .get<{ count: number }>(room.id))?.count,
    ).toBe(1);
    expect(await readBackfilledTo(asyncDb, STREAM)).toBe(8);
  })

  test("aggregates stats across multiple batches", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const { fake, getConnectedSpace } = withFake(STREAM);
    const mat = await SpaceMaterializer.start({
      streamDid: STREAM,
      db: asyncDb,
      getConnectedSpace,
    });

    fake.emit(
      [decoded(createRoomEvent("a"), 1), decoded(createRoomEvent("b"), 2)],
      { isBackfill: true },
    );
    fake.emit(
      [
        decoded(
          {
            $type: "space.roomy.does.not.exist.v0",
            id: newUlid(),
          } as unknown as Event,
          3,
        ),
        decoded(createRoomEvent("c"), 4),
      ],
      { isBackfill: true },
    );
    await mat.drain();

    const s = mat.getStats();
    expect(s.applied).toBe(3);
    expect(s.materializerErrors).toBe(1);
    expect(s.applyErrors).toBe(0);
    expect(s.batches).toBe(2);
    expect(await readBackfilledTo(asyncDb, STREAM)).toBe(4);
  })

  test("backfillDone resolves when subscribe's promise resolves", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const { fake, getConnectedSpace } = withFake(STREAM);
    const mat = await SpaceMaterializer.start({
      streamDid: STREAM,
      db: asyncDb,
      getConnectedSpace,
    });

    let resolved = false;
    mat.backfillDone.then(() => {
      resolved = true;
    });

    // Yield once — should still be pending.
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);

    fake.finishBackfill();
    await mat.backfillDone;
    expect(resolved).toBe(true);
  })

  test("prefetches profiles before applying a batch", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const { fake, getConnectedSpace } = withFake(STREAM);
    const getProfiles = mock(async () => [
      {
        did: USER,
        handle: "fake-user.test",
        displayName: "Fake User",
        avatar: "https://cdn.example/fake.png",
      },
    ]) as unknown as Parameters<
      typeof SpaceMaterializer.start
    >[0]["getProfiles"];

    const mat = await SpaceMaterializer.start({
      streamDid: STREAM,
      db: asyncDb,
      getConnectedSpace,
      getProfiles,
    });

    fake.emit(
      [
        decoded(
          {
            $type: "space.roomy.space.joinSpace.v0",
            id: newUlid(),
          } as unknown as Event,
          1,
        ),
      ],
      { isBackfill: true },
    );
    await mat.drain();

    // Profile fetched and persisted, even though the joinSpace materialiser
    // itself may have failed (it depends on fields we didn't populate).
    expect(
      (await asyncDb
        .query("select handle from comp_user where did = ?")
        .get<{ handle: string }>(USER))?.handle,
    ).toBe("fake-user.test");
  })

  test("a profile fetch failure does not block batch application", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const { fake, getConnectedSpace } = withFake(STREAM);
    const getProfiles = mock(async () => {
      throw new Error("appview down");
    }) as unknown as Parameters<
      typeof SpaceMaterializer.start
    >[0]["getProfiles"];

    const mat = await SpaceMaterializer.start({
      streamDid: STREAM,
      db: asyncDb,
      getConnectedSpace,
      getProfiles,
    });

    fake.emit(
      [
        // joinSpace triggers profile lookup (which will throw); the createRoom
        // event in the same batch must still apply.
        decoded(
          {
            $type: "space.roomy.space.joinSpace.v0",
            id: newUlid(),
          } as unknown as Event,
          1,
        ),
        decoded(createRoomEvent("survives"), 2),
      ],
      { isBackfill: true },
    );
    await mat.drain();

    expect(mat.getStats().applied).toBeGreaterThanOrEqual(1);
    expect(
      (await asyncDb
        .query("select count(*) as count from comp_room")
        .get<{ count: number }>())?.count,
    ).toBeGreaterThanOrEqual(1);
  })

  test("starts at idx 1 when no prior cursor exists", async () => {
    const { db, asyncDb } = freshDb();
    // No seedSpace — first subscription against a fresh stream.

    const { fake, getConnectedSpace } = withFake(STREAM);
    await SpaceMaterializer.start({
      streamDid: STREAM,
      db: asyncDb,
      getConnectedSpace,
    });

    expect(fake.start).toBe(1 as StreamIndex);
  })
});
