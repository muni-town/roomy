/**
 * Blue-green rematerialisation integration tests.
 *
 * Seeded + materialised at the OLD schema, a schema bump makes the canonical
 * per-space DB stale, and `reMaterializeFromLocalEvents` rebuilds it into a
 * temp `.sqlite.new` (begin → replay → commit) while the old DB keeps serving
 * reads and the write gate rejects writes. Covers the whole path end to end,
 * including a failed rebuild aborting so the old DB keeps serving.
 *
 * NOTE: this is a SEPARATE file from reMaterialize.test.ts on purpose. That
 * file's module-level `openDb()`/`closeDb()` spawn/terminate the shared
 * singleton pool (4 workers) around every test, and that worker churn
 * intermittently hangs a concurrently-active isolated pool under bun:test
 * (see blueGreen.test.ts). Keeping this file self-contained (one shared pool,
 * real temp `spacesDir`, no openDb singleton churn) is deterministic.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Database } from "bun:sqlite";
import { encode } from "@atcute/cbor";
import {
  newUlid,
  StreamDid,
  UserDid,
  type Event,
} from "@roomy-space/sdk";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabasePool } from "../db/pool.ts";
import {
  GLOBAL_SCHEMA_VERSION,
  SPACE_SCHEMA_VERSION,
} from "../db/db.ts";
import { READSTATE_SCHEMA_VERSION } from "../db/readStateDb.ts";
import type { DbLike } from "../db/types.ts";
import { reMaterializeFromLocalEvents } from "./reMaterialize.ts";
import {
  SpaceRematerializingError,
  StreamManager,
} from "./StreamManager.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(THIS_DIR, "../db/schema-space.sql");
const ADMIN = UserDid.assert("did:plc:test-admin");

/** Seed events into the event-log `stream_events` for a given stream. */
async function seedEvents(
  db: DbLike,
  streamDid: StreamDid,
  events: Record<string, unknown>[],
  user: UserDid = ADMIN,
  startIdx: number = 0,
): Promise<void> {
  for (let i = 0; i < events.length; i++) {
    const payload = encode(events[i] as Parameters<typeof encode>[0]);
    await db.run(
      "insert into stream_events (stream_id, idx, user, payload, signature) values (?, ?, ?, ?, x'')",
      streamDid,
      startIdx + i,
      user,
      payload,
    );
  }
}

/** Poll `fn` until it returns truthy, or throw after `timeoutMs`. */
async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

describe("blue-green rematerialization", () => {
  let pool: DatabasePool;
  let router: DbLike;
  let spacesDir: string;
  let nextSpace = 0;
  let streamDid: StreamDid;
  let canonicalPath: string;

  beforeAll(async () => {
    spacesDir = mkdtempSync(join(tmpdir(), "roomy-bluegreen-"));
    pool = new DatabasePool(1, join(THIS_DIR, "../db/worker.ts"));
    await pool.init({
      readStateDbPath: ":memory:",
      eventsDbPath: ":memory:",
      globalDbPath: ":memory:",
      spacesDir,
      readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
      spaceSchemaVersion: SPACE_SCHEMA_VERSION,
      globalSchemaVersion: GLOBAL_SCHEMA_VERSION,
    });
    router = pool.router();
  });

  afterAll(async () => {
    await pool.close();
    rmSync(spacesDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Unique stream + clean file slate per test (no per-test worker churn —
    // see blueGreen.test.ts for why a shared pool is required in bun:test).
    streamDid = StreamDid.assert(`did:web:bluegreen-${nextSpace++}.example`);
    canonicalPath = join(spacesDir, `${streamDid}.sqlite`);
    for (const f of [canonicalPath, `${canonicalPath}.new`]) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(f + suffix, { force: true });
        } catch {
          /* already gone */
        }
      }
    }
  });

  /** Seed a canonical per-space DB at the OLD schema version. */
  function seedOldSpaceDb() {
    const sdb = new Database(canonicalPath, { create: true });
    sdb.exec(readFileSync(SCHEMA_PATH, "utf8"));
    sdb.run("insert into space_schema_version (id, version) values (1, '0')");
    sdb.run("insert into entities (id, stream_id) values (?, ?)", [
      "entity-old",
      streamDid,
    ]);
    sdb.close();
  }

  test(
    "rebuilds a stale space while serving old reads and rejecting writes",
    async () => {
      const author = UserDid.assert("did:plc:bluegreen-author");
      seedOldSpaceDb();

      // Seed the event log (joinSpace triggers profile hydration, holding the
      // window open; createRoom materialises into comp_room).
      const roomId = newUlid();
      await seedEvents(router, streamDid, [
        { $type: "space.roomy.space.joinSpace.v0", id: newUlid() },
        {
          $type: "space.roomy.room.createRoom.v0",
          id: roomId,
          kind: "space.roomy.channel",
          name: "general",
        },
      ], author);

      // The canonical DB is on a stale schema → must take the rebuild path.
      expect((await router.checkSpaceSchema!(streamDid)).current).toBe(false);

      const sm = new StreamManager(router, {
        appserverUrl: "https://appserver.example",
        getProfiles: (async () => []) as never,
      });

      // While the space is marked rebuilding, the single write gate in
      // StreamManager.sendEvents rejects the write BEFORE it lands in the
      // event log. This is checked with a controlled begin→abort cycle (no
      // concurrent reMaterialize hammering the same single worker, which is
      // flaky under bun:test) — the gate's predicate `isSpaceRebuilding` is
      // exactly what the window also sets (verified below via waitFor).
      await router.spaceRebuildBegin!(streamDid);
      // Note: assert the rejection with a manual catch. bun:test's
      // `expect(...).rejects` matcher hangs when the rejection originates from
      // a WorkerLink message error, so we resolve the rejection explicitly.
      const gateErr = await sm
        .sendEvents(streamDid, [
          {
            id: newUlid(),
            $type: "space.roomy.room.createRoom.v0",
            kind: "space.roomy.channel",
            name: "write-during-rebuild",
          },
        ], author)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(gateErr).toBeInstanceOf(SpaceRematerializingError);
      const logCount = await router
        .query("select count(*) as c from stream_events where stream_id = ?")
        .get<{ c: number }>(streamDid);
      expect(logCount!.c).toBe(2); // only the 2 seeded events; the write did NOT land
      await router.spaceRebuildAbort!(streamDid);
      expect(await router.isSpaceRebuilding!(streamDid)).toBe(false);

      // Slow getProfiles: blocks the first profile hydration so the rebuild
      // window stays open until we've asserted reads.
      let release!: () => void;
      const blocked = new Promise<void>((r) => (release = r));
      const getProfiles = mock(async (dids: UserDid[]) => {
        await blocked;
        return dids.map((d) => ({
          did: d,
          handle: "bluegreen.test",
          displayName: "BlueGreen Author",
        }));
      });

      const remat = reMaterializeFromLocalEvents(
        router,
        getProfiles as never,
        null,
        1,
      );

      // Wait until the rebuild has begun (temp DB created, space marked
      // rebuilding) — the window is now open.
      await waitFor(() => router.isSpaceRebuilding!(streamDid));

      // During the window, reads serve the OLD DB, not empty/partial.
      const oldRow = await router
        .forSpace!(streamDid)
        .query("select id from entities where id = ?")
        .get<{ id: string }>("entity-old");
      expect(oldRow?.id).toBe("entity-old");

      // Release the window; await the rebuild completing.
      release();
      await remat;

      // After swap, the new DB is a complete rematerialisation — the old
      // row is gone and the new room is present (comp_room row + comp_info name).
      const roomCount = await router
        .forSpace!(streamDid)
        .query("select count(*) as c from comp_room")
        .get<{ c: number }>();
      expect(roomCount!.c).toBe(1);
      const roomInfo = await router
        .forSpace!(streamDid)
        .query("select name from comp_info where entity = ?")
        .get<{ name: string }>(roomId);
      expect(roomInfo?.name).toBe("general");
      const oldGone = await router
        .forSpace!(streamDid)
        .query("select id from entities where id = ?")
        .get<{ id: string }>("entity-old");
      expect(oldGone).toBeNull();

      // Cursor is current, schema is current, space no longer rebuilding.
      const cursor = await router
        .forSpace!(streamDid)
        .query(
          "select materialized_to from materialization_cursor where stream_id = ?",
        )
        .get<{ materialized_to: number }>(streamDid);
      expect(cursor!.materialized_to).toBe(1); // 2 events, idx 0..1
      expect((await router.checkSpaceSchema!(streamDid)).current).toBe(true);
      expect(await router.isSpaceRebuilding!(streamDid)).toBe(false);

      // A second cold rematerialisation is a no-op (cursor unchanged).
      await reMaterializeFromLocalEvents(router, getProfiles as never, null, 1);
      const cursor2 = await router
        .forSpace!(streamDid)
        .query(
          "select materialized_to from materialization_cursor where stream_id = ?",
        )
        .get<{ materialized_to: number }>(streamDid);
      expect(cursor2!.materialized_to).toBe(1);
    },
  );

  test("a failed rebuild aborts and the old DB keeps serving", async () => {
    seedOldSpaceDb();

    await seedEvents(router, streamDid, [
      { $type: "space.roomy.space.joinSpace.v0", id: newUlid() },
    ]);

    // getProfiles throws → ensureProfiles path fails mid-rebuild.
    const getProfiles = mock(async () => {
      throw new Error("profile fetch failed");
    });

    // reMaterializeFromLocalEvents catches per-stream errors, so this resolves
    // with the stream counted as failed.
    await reMaterializeFromLocalEvents(router, getProfiles as never, null, 1);

    // The rebuild was aborted: old data still served, not rebuilding, temp gone.
    const oldRow = await router
      .forSpace!(streamDid)
      .query("select id from entities where id = ?")
      .get<{ id: string }>("entity-old");
    expect(oldRow?.id).toBe("entity-old");
    expect(await router.isSpaceRebuilding!(streamDid)).toBe(false);
    expect(existsSync(`${canonicalPath}.new`)).toBe(false);
  });
});