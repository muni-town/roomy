import { describe, expect, test } from "bun:test";
import { openDb, closeDb } from "./db.ts";
import { hashSpace } from "./pool.ts";

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
