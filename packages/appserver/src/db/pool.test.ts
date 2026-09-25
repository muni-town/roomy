import { describe, expect, test } from "bun:test";
import { openDb, closeDb } from "./db.ts";
import { hashSpace } from "./pool.ts";

describe("hashSpace", () => {
  test("is deterministic across calls", () => {
    const did = "did:plc:drzgt2m6lmcel62gfbzjeap3";
    expect(hashSpace(did)).toBe(hashSpace(did));
  });

  test("distributes a realistic set of DIDs across a pool", () => {
    const n = 4;
    const counts = new Array(n).fill(0);
    for (let i = 0; i < 200; i++) {
      const did = `did:plc:test${i.toString().padStart(4, "0")}`;
      counts[hashSpace(did) % n]!++;
    }
    // Within ±40% of uniform (200/4 = 50) — a loose bound that catches
    // pathological clustering without being flaky.
    for (const c of counts) {
      expect(c).toBeGreaterThan(30);
      expect(c).toBeLessThan(70);
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
