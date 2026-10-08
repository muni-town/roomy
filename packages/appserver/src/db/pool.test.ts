import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import { openDb, closeDb, poolStats } from "./db.ts";
import { hashSpace, type PooledDatabase } from "./pool.ts";
import {
  DEFAULT_MAX_PREPARED_STMTS,
  DEFAULT_MAX_SPACE_DBS,
  DEFAULT_SPACE_DB_CACHE_KIB,
} from "./bounds.ts";
import { updateSeenHandler } from "../handlers/space.roomy.room.updateSeen.ts";

describe("hashSpace", () => {
  test("is deterministic across calls", () => {
    const did = "did:plc:drzgt2m6lmcel62gfbzjeap3";
    expect(hashSpace(did)).toBe(hashSpace(did));
  });

  test("a space always lands on the same worker for a given pool size", () => {
    const did = "did:plc:drzgt2m6lmcel62gfbzjeap3";
    const n = 8;
    expect(hashSpace(did) % n).toBe(hashSpace(did) % n);
  });

  test("the two highest-traffic spaces occupy different workers at size 8", () => {
    // Sharing a worker serializes both spaces' reads and materialization on
    // one thread, so the two busiest spaces must land on different workers.
    const meri = "did:plc:drzgt2m6lmcel62gfbzjeap3";
    const other = "did:plc:qzie4v7qwnv3mzaflihrf56f";
    expect(hashSpace(meri) % 8).not.toBe(hashSpace(other) % 8);
  });

  test("distributes a corpus of DIDs without a grossly outsized share", () => {
    // Synthetic `did:plc:` DIDs: 24 base32 chars after the prefix, the shape
    // real PLC DIDs have. A xorshift PRNG keeps the corpus deterministic and
    // the test free of a flaky random seed.
    const base32 = "abcdefghijklmnopqrstuvwxyz234567";
    let state = 0x9e3779b1;
    const next = () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    };
    const dids: string[] = [];
    for (let i = 0; i < 512; i++) {
      let did = "did:plc:";
      for (let j = 0; j < 24; j++) did += base32[(next() >>> 8) % 32];
      dids.push(did);
    }

    for (const n of [4, 8]) {
      const counts = new Array(n).fill(0);
      for (const did of dids) counts[hashSpace(did) % n]!++;
      const expected = dids.length / n;
      // Within 50% of an even share: loose enough not to trip on sampling
      // noise, tight enough to catch gross clustering (one worker at 2x).
      for (const c of counts) {
        expect(c).toBeGreaterThan(expected * 0.5);
        expect(c).toBeLessThan(expected * 1.5);
      }
    }
  });

  test("every low hash bit reacts to a single-bit change in the DID", () => {
    // Routing reads only the low bits of the hash (`% N`), so each low bit must
    // flip ~50% of the time when a single input bit in the DID flips.
    const base32 = "abcdefghijklmnopqrstuvwxyz234567";
    let state = 0x12345678;
    const next = () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    };
    const dids: string[] = [];
    for (let i = 0; i < 256; i++) {
      let did = "did:plc:";
      for (let j = 0; j < 24; j++) did += base32[(next() >>> 8) % 32];
      dids.push(did);
    }

    const flips = [0, 0, 0];
    let trials = 0;
    for (const did of dids) {
      const base = hashSpace(did);
      for (let i = 8; i < did.length; i++) {
        for (let bit = 0; bit < 5; bit++) {
          const mutated = did.slice(0, i) +
            String.fromCharCode(did.charCodeAt(i) ^ (1 << bit)) +
            did.slice(i + 1);
          const h = hashSpace(mutated);
          for (let k = 0; k < 3; k++) {
            if (((base >>> k) & 1) !== ((h >>> k) & 1)) flips[k]!++;
          }
          trials++;
        }
      }
    }

    for (const f of flips) {
      const rate = f / trials;
      expect(rate).toBeGreaterThan(0.4);
      expect(rate).toBeLessThan(0.6);
    }
  });
});

describe("DatabasePool routing", () => {
  test("per-space writes land in the owning worker and read back", async () => {
    // Isolated pool (size 1) so this test never touches the process-wide
    // singleton that other test files share.
    const db = openDb({ path: ":memory:", isolated: true });
    const spaceA = "did:plc:pool-a";
    const spaceB = "did:plc:pool-b";

    await db.forSpace(spaceA).run(
      "insert into entities (id, stream_id) values (?, ?)",
      "entity-a",
      spaceA,
    );
    await db.forSpace(spaceB).run(
      "insert into entities (id, stream_id) values (?, ?)",
      "entity-b",
      spaceB,
    );

    const a = await db.forSpace(spaceA)
      .query("select id from entities where id = ?")
      .get<{ id: string }>("entity-a");
    const b = await db.forSpace(spaceB)
      .query("select id from entities where id = ?")
      .get<{ id: string }>("entity-b");
    expect(a?.id).toBe("entity-a");
    expect(b?.id).toBe("entity-b");

    // The global DB is shared across spaces (global worker).
    await db.global().run(
      "insert into edges (head, tail, label) values (?, ?, ?)",
      "user",
      spaceA,
      "joinedSpace",
    );
    const row = await db.global()
      .query("select tail from edges where head = ? and label = 'joinedSpace'")
      .get<{ tail: string }>("user");
    expect(row?.tail).toBe(spaceA);

    await db.close();
  });

  test("router dispatches to global and read-state workers", async () => {
    const db = openDb({ path: ":memory:", isolated: true });
    // The read-state DB is a real file shared across isolated pools, so use a
    // unique key to avoid UNIQUE collisions with other test runs.
    const room = `room-${Math.random().toString(36).slice(2, 8)}`;

    await db.global().run(
      "insert into edges (head, tail, label) values (?, ?, ?)",
      "u",
      "s",
      "joinedSpace",
    );
    await db.readState().run(
      "insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count) values (?, ?, ?, ?, ?)",
      "u",
      room,
      "s",
      "0",
      0,
    );

    const e = await db.global()
      .query("select tail from edges where head = ? and label = 'joinedSpace'")
      .get<{ tail: string }>("u");
    expect(e?.tail).toBe("s");

    const rp = await db.readState()
      .query("select unread_count from read_positions where user_did = ? and room_id = ?")
      .get<{ unread_count: number }>("u", room);
    expect(rp?.unread_count).toBe(0);

    await db.close();
  });
});

describe("per-space query-planner statistics", () => {
  /**
   * Query plan SQLite picks for the `entities.id` lookup that every
   * room/message read funnels through (`readPositions`, `userActiveThreads`).
   */
  const planFor = async (
    db: PooledDatabase,
    spaceDid: string,
  ): Promise<string> => {
    // 23 bound ids: the shape production's `readPositions`/`userActiveThreads`
    // lookups actually issue (they build one placeholder per thread id).
    const ids = Array.from({ length: 23 }, (_, i) => `entity-${i}`);
    const placeholders = ids.map(() => "?").join(",");
    const rows = await db
      .forSpace(spaceDid)
      .query(
        `explain query plan
           select id from entities
            where id in (${placeholders}) and stream_id = ?`,
      )
      .all<{ detail: string }>(...ids, spaceDid);
    return rows.map((r) => r.detail).join(" | ");
  };

  test("a space with no statistics resolves entities by rowid, not by partition scan", async () => {
    // Without statistics SQLite costs the single-column `stream_id` index below
    // the rowid index, and scans the whole `stream_id` partition to answer a
    // lookup for a handful of ids. That scan runs on the space's only worker,
    // so it is paid by every other request queued behind it. Statistics are
    // what let the planner see the rowid index is the selective one.
    //
    // The fixture is inserted as one multi-row statement rather than a loop:
    // every `run()` is a worker round-trip, and one per row costs more than the
    // test budget. The plan is then read through `analyze`, which is the same
    // call an eviction or the boot sweep makes — the fixture reaches its row
    // count after the open that would normally have analyzed it.
    const db = openDb({ path: ":memory:", isolated: true });
    const space = "did:plc:plan-stats";
    const rows = 2000;
    const values = Array.from(
      { length: rows },
      (_, i) => `('entity-${i}', '${space}', 'room-${i % 20}')`,
    ).join(",");
    await db
      .forSpace(space)
      .exec(`insert into entities (id, stream_id, room) values ${values}`);

    expect(await planFor(db, space)).toContain("idx_entities_stream_room");

    await db.forSpace(space).analyze();

    expect(await planFor(db, space)).toContain("sqlite_autoindex_entities_1");

    await db.close();
  });

  test("analyzeShared refreshes the shared databases' statistics", async () => {
    // A shared DB's statistics are only ever created by this call — the
    // open-time refresh covers per-space DBs, and nothing else runs ANALYZE on
    // a shared one — so their presence, and their agreement with the row count
    // just written, is what "the shared DBs were refreshed" means. The global
    // `entity_space` index is the one every room/message handler resolves an
    // owner through, and it grows with the whole fleet's entities rather than
    // one space.
    const db = openDb({ path: ":memory:", isolated: true });
    const space = "did:plc:shared-stats";
    const rows = 2000;
    const values = Array.from(
      { length: rows },
      (_, i) => `('entity-${i}', '${space}')`,
    ).join(",");
    await db
      .global()
      .exec(`insert into entity_space (entity_id, space_did) values ${values}`);

    await db.analyzeShared();

    const row = await db
      .global()
      .query(
        "select stat from sqlite_stat1 where tbl = 'entity_space' and idx = 'sqlite_autoindex_entity_space_1'",
      )
      .get<{ stat: string }>();
    expect(row?.stat?.split(" ")[0]).toBe("2000");

    await db.close();
  });
});

describe("DatabasePool teardown", () => {
  // Yield to the event loop so a latent unhandled-rejection (had the bug
  // been present) would be surfaced before the assertion. The worker pool is
  // a real thread, so this cannot be driven by fake timers; a macrotask
  // yield (setImmediate) is deterministic and costs no wall-clock time.
  const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

  test("fire-and-forget routed run() before closeDb() raises no unhandled rejection", async () => {
    // The teardown path must not surface an unhandled rejection: terminating
    // the worker mid-request rejects the pending `send()` promise, and a DB
    // wrapper that re-wraps it in a fresh promise would leave that rejection
    // unhandled and fail the whole `bun test` run.
    const unhandled: Error[] = [];
    const onUnhandled = (e: Error) => {
      unhandled.push(e);
      process.exit(9); // fail loudly — do not let the run limp on
    };
    process.on("unhandledRejection", onUnhandled);

    // Use the process-wide singleton (what `closeDb()` tears down) — the
    // same path the e2e helpers use (seedEvent / seedBareSpace / addMember).
    const db = openDb({ path: ":memory:" });
    // Fire-and-forget seeded write, exactly like the e2e helpers do.
    void db.forSpace("did:plc:teardown-regression").run(
      "insert or ignore into entities (id, stream_id) values (?, ?)",
      "entity-teardown",
      "did:plc:teardown-regression",
    );

    try {
      // Tear down while the fire-and-forget request may still be in flight.
      closeDb();
      // Let worker termination reject any pending request, surfacing a
      // latent unhandled rejection before we assert.
      await yieldToLoop();
      await yieldToLoop();
    } finally {
      openDb({ path: ":memory:" });
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  test("fire-and-forget routed run() after closeDb() raises no unhandled rejection", async () => {
    const unhandled: Error[] = [];
    const onUnhandled = (e: Error) => {
      unhandled.push(e);
      process.exit(9);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      openDb({ path: ":memory:" });
      closeDb();
      // Post-teardown call — it must reject the returned promise, not throw
      // synchronously.
      void openDb({ path: ":memory:" }).forSpace("did:plc:after-close").run(
        "insert or ignore into entities (id, stream_id) values (?, ?)",
        "entity-after",
        "did:plc:after-close",
      );
      await yieldToLoop();
      await yieldToLoop();
    } finally {
      openDb({ path: ":memory:" });
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  test("fire-and-forget prepare() after closeDb() raises no unhandled rejection", async () => {
    const unhandled: Error[] = [];
    const onUnhandled = (e: Error) => {
      unhandled.push(e);
      process.exit(9);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const db = openDb({ path: ":memory:" });
      // Fire-and-forget prepared statement creation, dropped (no await). A
      // still-`async` prepare() wrapper would wrap the send() promise in a
      // brand-new outer promise, so the post-teardown rejection surfaced as
      // an unhandled rejection. The handled pass-through must not.
      void db.forSpace("did:plc:after-close").prepare(
        "insert or ignore into entities (id, stream_id) values (?, ?)",
      );
      closeDb();
      await yieldToLoop();
      await yieldToLoop();
    } finally {
      openDb({ path: ":memory:" });
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});

describe("worker cache bounds", () => {
  // The prepared-statement map is keyed by an ever-incrementing handle, so a
  // caller that prepares per invocation and never finalizes used to leave one
  // compiled statement — native memory the JS GC cannot reclaim — behind per
  // call. The bound caps the map at `maxPreparedStmts`, and the counts are read
  // back through `poolStats()` (the `health` round-trip `/health/pool` uses).
  test("the prepared-statement map does not grow with a leaking caller", async () => {
    // The process-wide singleton, so `poolStats()` reads the pool the handle
    // actually routes to.
    closeDb();
    const db = openDb({ path: ":memory:" });
    const space = db.forSpace("did:plc:stmt-bound");
    await space.run(
      "insert into entities (id, stream_id) values (?, ?)",
      "entity-stmt",
      "did:plc:stmt-bound",
    );
    // The SQL is identical every time; the leak is the handle, not the text.
    // 1000 prepares is several times the ceiling, so the bound is observed both
    // reached and held, and few enough round-trips to stay well under the test
    // timeout under CI's --isolate load.
    for (let i = 0; i < 1000; i++) {
      await space.prepare("select id from entities where id = ?");
    }

    const stats = (await poolStats())!;
    const held = stats.spaceWorkers.reduce((n, w) => n + w.preparedStmts, 0);
    // Bound is live, not vacuously zero: the ceiling is reached, yet never
    // exceeded, despite more prepares than the ceiling.
    expect(stats.maxPreparedStmts).toBe(DEFAULT_MAX_PREPARED_STMTS);
    expect(held).toBe(stats.maxPreparedStmts);
    closeDb();
  }, 30_000);

  test("the prepared-statement bound is an LRU: a kept handle stays usable", async () => {
    // The bound must not be insertion-order, or a long-lived handle a caller
    // keeps executing would be finalized out from under it by a leaking
    // neighbour. `takeStatement` refreshes the handle on every use, so here the
    // kept handle survives 500 prepares of pressure and still runs.
    closeDb();
    const db = openDb({ path: ":memory:" });
    const space = db.forSpace("did:plc:stmt-lru");
    await space.run(
      "insert into entities (id, stream_id) values (?, ?)",
      "entity-lru",
      "did:plc:stmt-lru",
    );
    const kept = await space.prepare("select id from entities where id = ?");
    for (let i = 0; i < 500; i++) {
      // Refresh the kept handle's recency, then prepare-and-drop another.
      await kept.get("entity-lru");
      await space.prepare("select 1");
    }
    // If the bound evicted the kept handle, this would throw
    // "Unknown prepared statement handle".
    const row = await kept.get<{ id: string }>("entity-lru");
    expect(row?.id).toBe("entity-lru");

    closeDb();
  }, 30_000);

  test("the updateSeen write path holds no prepared statements across many calls", async () => {
    // The mark-as-read handler used to `prepare` a one-shot insert per call and
    // never finalize it. It goes through `run` now, which the worker compiles
    // through its SQL cache: same row written, zero held statements. The
    // handler resolves its DBs through `openDb()`, so this drives the
    // process-wide singleton.
    closeDb();
    const db = openDb({ path: ":memory:" });
    const spaceDid = "did:web:stmt-bound-updateseen";
    const roomId = newUlid();
    const msgId = newUlid();
    const space = db.forSpace(spaceDid);
    await space.run("insert into entities (id, stream_id) values (?, ?)", [
      spaceDid,
      spaceDid,
    ]);
    await space.run("insert into entities (id, stream_id) values (?, ?)", [
      roomId,
      spaceDid,
    ]);
    await space.run(
      "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
      [msgId, spaceDid, roomId, "a"],
    );
    await db.global().run(
      "insert into entity_space (entity_id, space_did) values (?, ?)",
      [roomId, spaceDid],
    );

    const did = "did:plc:stmt-bound-user";
    // 200 calls: every one is several worker round-trips, so a larger count
    // risks the default 5s test timeout under CI's --isolate load. 200 still
    // proves the path holds nothing by call count. The explicit timeout keeps a
    // loaded runner from turning a slow-but-correct run into a failure.
    for (let i = 0; i < 200; i++) {
      await updateSeenHandler({}, { did }, { roomId });
    }

    const stats = (await poolStats())!;
    expect(stats.spaceWorkers.reduce((n, w) => n + w.preparedStmts, 0)).toBe(0);
    expect(stats.readStateWorker.preparedStmts).toBe(0);

    closeDb();
  }, 30_000);

  test("the space-DB cache reports open connections against its bound", async () => {
    closeDb();
    const db = openDb({ path: ":memory:" });
    for (let i = 0; i < 6; i++) {
      const did = `did:plc:space-bound-${i}`;
      await db
        .forSpace(did)
        .run("insert into entities (id, stream_id) values (?, ?)", [`e${i}`, did]);
    }
    const stats = (await poolStats())!;
    // Six opens against the default ceiling: all held, none evicted.
    expect(stats.maxSpaceDbs).toBe(DEFAULT_MAX_SPACE_DBS);
    expect(stats.cacheKib).toBe(DEFAULT_SPACE_DB_CACHE_KIB);
    expect(stats.spaceWorkers.reduce((n, w) => n + w.openSpaceDbs, 0)).toBe(6);
    expect(
      stats.spaceWorkers.every((w) => w.openSpaceDbs <= stats.maxSpaceDbs),
    ).toBe(true);

    closeDb();
  });
});

describe("cache bounds from the environment", () => {
  // The three bounds are read once, when the pool opens, from
  // APPSERVER_MAX_SPACE_DBS / APPSERVER_MAX_PREPARED_STMTS /
  // APPSERVER_SPACE_DB_CACHE_KIB. These are the operator's only lever on the
  // appserver's native-memory ceiling, so the override must reach the workers
  // and be visible on the stats the health route serves.
  const KEYS = [
    "APPSERVER_MAX_SPACE_DBS",
    "APPSERVER_MAX_PREPARED_STMTS",
    "APPSERVER_SPACE_DB_CACHE_KIB",
  ] as const;

  test("the worker honours env overrides and rejects malformed values", async () => {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    try {
      process.env.APPSERVER_MAX_SPACE_DBS = "3";
      process.env.APPSERVER_MAX_PREPARED_STMTS = "7";
      process.env.APPSERVER_SPACE_DB_CACHE_KIB = "256";
      closeDb();
      const db = openDb({ path: ":memory:" });
      // A space DB has to open for its worker's cache stats to be meaningful,
      // but the bounds are reported regardless.
      await db.forSpace("did:plc:env-bounds").run(
        "insert into entities (id, stream_id) values (?, ?)",
        ["e", "did:plc:env-bounds"],
      );
      const stats = (await poolStats())!;
      expect(stats.maxSpaceDbs).toBe(3);
      expect(stats.maxPreparedStmts).toBe(7);
      expect(stats.cacheKib).toBe(256);
      closeDb();

      // A malformed value falls back to the default rather than a NaN/0 bound
      // (which would close every connection or evict every statement).
      process.env.APPSERVER_MAX_SPACE_DBS = "not-a-number";
      openDb({ path: ":memory:" });
      const stats2 = (await poolStats())!;
      expect(stats2.maxSpaceDbs).toBe(DEFAULT_MAX_SPACE_DBS);
      closeDb();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
