import { beforeAll, afterAll, describe, expect, test, vi } from "bun:test";

import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  startEmbedSweeper,
  prioritiseLinksForRead,
  sweepCycle,
  _resetEmbedSweeper,
  _startSweeperNoLoop,
  stopEmbedSweeper,
  embedSweeperStats,
  classifyStallCause,
  sweepIdleDelayMs,
  _setSweepWaitForTest,
  sweepYieldsAfter,
  type EmbedSweeperOpts,
  type SweepCycleResult,
} from "./sweeper.ts";
import { openDb, openGlobalDb, openSpaceDb, closeDb } from "../db/db.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
} from "../invalidation/types.ts";

// Deterministic fake page so the sweeper test doesn't depend on the network
// or a live embed service. Enrichment now runs through the in-appserver
// OG/oEmbed pipeline, which fetches the target URL directly — so the mock
// must return HTML with OpenGraph meta tags. The sweeper only emits a
// #messageDiff when enrichment SUCCEEDS (non-null embed).
const FAKE_HTML =
  "<html><head>" +
  '<meta property="og:title" content="Example Article" />' +
  '<meta property="og:description" content="A test embed." />' +
  "</head></html>";
const realFetch = globalThis.fetch;

beforeAll(() => {
  // Point every DB at in-memory storage so the shared worker (used by
  // openGlobalDb / openSpaceDb) never touches the filesystem across tests.
  process.env.DATA_DIR = ":memory:";
  globalThis.fetch = ((
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> =>
    Promise.resolve(
      new Response(FAKE_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    )) as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  stopEmbedSweeper();
  closeDb();
});

/**
 * Captures every invalidation signal emitted by the sweeper so tests can
 * assert on which rooms were invalidated.
 */
function captureRouter(): {
  router: InvalidationRouter;
  signals: InvalidationEvent[];
} {
  const signals: InvalidationEvent[] = [];
  const router: InvalidationRouter = {
    onEventsApplied: () => {},
    emit: (s) => signals.push(...s),
    subscribe: () => () => {},
  };
  return { router, signals };
}

const SPACE_DID = "did:web:test.example";

/**
 * Stop any running sweeper, tear down the previous worker, and open a fresh
 * in-memory worker with routed global + per-space handles. Each test gets an
 * isolated set of in-memory DBs.
 */
function freshWorker(): { globalDb: DbLike; spaceDb: DbLike } {
  stopEmbedSweeper();
  closeDb();
  openDb();
  return { globalDb: openGlobalDb(), spaceDb: openSpaceDb(SPACE_DID) };
}

/**
 * Seed the minimum entity rows for a link-in-a-message-in-a-room scenario in
 * the per-space DB, plus the matching global `pending_links` row.
 */
async function seedLinkMessageRoom(
  spaceDb: DbLike,
  globalDb: DbLike,
  ids: { room: string; message: string; url: string },
  createdAt?: number,
): Promise<void> {
  // Room entity (its own room column is null — rooms don't belong to rooms).
  await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [
    ids.room,
    SPACE_DID,
  ]);
  // Message entity — room column holds the REAL room id.
  await spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    ids.message,
    SPACE_DID,
    ids.room,
  ]);
  // Link entity — room column holds the MESSAGE id (not the room id!).
  await spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    ids.url,
    SPACE_DID,
    ids.message,
  ]);
  await spaceDb.run(
    "insert into comp_embed_link (entity, show_preview) values (?, 1)",
    [ids.url],
  );
  // Global pending-links index row (the sweeper's work queue).
  // Global pending-links index row (the sweeper's work queue). `createdAt`
  // defaults to now; tests that exercise backlog-stall detection seed an
  // older timestamp to simulate a backlog that has sat untouched.
  await globalDb.run(
    "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
    [SPACE_DID, ids.message, ids.url, createdAt ?? Date.now()],
  );
}

/**
 * Drive the sweeper through one pending batch synchronously. The sweeper is
 * a detached async loop; for testing we call sweepCycle directly instead of
 * starting the background loop, then stop it to prevent interference.
 */
async function flushSweeper(opts: EmbedSweeperOpts): Promise<void> {
  // Stop any running background loop from a prior test.
  await stopEmbedSweeper();
  startEmbedSweeper(opts);
  // Run one cycle synchronously, then stop the background loop.
  await sweepCycle(opts.globalDb);
  await stopEmbedSweeper();
}
/**
 * Wait for `done()` to hold, driving the event loop with `setImmediate` turns
 * rather than a wall-clock sleep. The sweeper loop parks on an injected wait
 * (see _setSweepWaitForTest) so the condition is reached deterministically;
 * the turns only give the SQLite worker's round-trips room to resolve.
 *
 * Fails loudly on timeout instead of hanging the suite.
 */
async function settleUntil(done: () => boolean, maxTurns = 100_000): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (done()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error("settleUntil: condition never held within the turn budget");
}

describe("embed sweeper invalidation room resolution", () => {
  test("emits a #messageDiff update with the real room id, not the message id", async () => {
    const { globalDb, spaceDb } = freshWorker();
    const { router, signals } = captureRouter();
    const ids = {
      room: "01KVQQQQQQQQQQQQQQQQQQQQQQ",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url: "https://example.com/article",
    };
    await seedLinkMessageRoom(spaceDb, globalDb, ids);

    await flushSweeper({ globalDb, invalidationRouter: router });

    // The sweeper loop is async and waits on fetchEmbedData (network). Give
    // it a moment to process the pending link, then assert. We use a generous
    // microtask/timer flush since the actual fetch will fail fast against
    // a non-existent service (or time out — but the mock env URL isn't set).
    // Wait for signals with a timeout guard.
    const deadline = Date.now() + 15_000;
    while (signals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    _resetEmbedSweeper();

    expect(signals.length).toBeGreaterThan(0);

    // There must be a #messageDiff targeting the real ROOM id (not the
    // message id) with an update op keyed on the message id. (The sweeper
    // also emits queryInvalidation signals for the links views; this test
    // only asserts the streaming diff contract.)
    for (const sig of signals) {
      if (sig.kind !== "messageDiff") continue;
      expect(sig.signal.roomId as string).toBe(ids.room);
      expect(sig.signal.ops.length).toBeGreaterThan(0);
      for (const op of sig.signal.ops) {
        expect(op.op).toBe("update");
        expect(op.key as string).toBe(ids.message);
        // The update op must carry the enriched embed data so the client can
        // render the card without a re-fetch (this is the streaming payoff).
        if (op.op === "update") {
          const link = op.message.linkEmbeds[0];
          expect(link).toBeDefined();
          expect(link?.embed?.["t"]).toBe("Example Article");
        }
      }
    }

    // Explicitly assert the sweep produced the room-targeted diff.
    const diffs = signals.filter((s) => s.kind === "messageDiff");
    expect(diffs.length).toBeGreaterThan(0);

    // Explicitly assert the bug is fixed: the message id must NOT appear as
    // the diff's roomId.
    const diffRoomIds = signals
      .filter((s) => s.kind === "messageDiff")
      .map((s) => (s.kind === "messageDiff" ? (s.signal.roomId as string) : null));
    expect(diffRoomIds).not.toContain(ids.message);
  }, { timeout: 20000 });

  test("does not emit when no pending links exist", async () => {
    const { globalDb } = freshWorker();
    const { router, signals } = captureRouter();

    await flushSweeper({ globalDb, invalidationRouter: router });

    // Let the loop idle once.
    await new Promise((r) => setTimeout(r, 100));
    _resetEmbedSweeper();

    expect(signals.length).toBe(0);
  });

  test("read-driven prioritisation enriches a viewed message's pending link", async () => {
    // Regression: links in messages a user is READING (detected during
    // backfill, never write-poked) would otherwise sit behind the entire
    // backlog. The read handler calls prioritiseLinksForRead so they jump the
    // queue.
    const { globalDb, spaceDb } = freshWorker();
    const { router, signals } = captureRouter();
    const ids = {
      room: "01KVRRRRRRRRRRRRRRRRRRRRRR",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url: "https://example.com/read-viewed",
    };
    await seedLinkMessageRoom(spaceDb, globalDb, ids);

    // Simulate the getMessages handler: prioritise the viewed message's links.
    // Called BEFORE the sweeper is started (as it would be on a cold read).
    await prioritiseLinksForRead(spaceDb, [{ linkEmbeds: [{ url: ids.url }] }]);

    await flushSweeper({ globalDb, invalidationRouter: router });

    const deadline = Date.now() + 15_000;
    while (signals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    _resetEmbedSweeper();

    // The read-viewed link was enriched and streamed as a #messageDiff.
    expect(signals.length).toBeGreaterThan(0);
    const sig = signals.find((s) => s.kind === "messageDiff");
    expect(sig?.kind).toBe("messageDiff");
    if (sig?.kind === "messageDiff") {
      expect(sig.signal.roomId as string).toBe(ids.room);
      const op = sig.signal.ops[0];
      expect(op?.op).toBe("update");
      expect(op?.key as string).toBe(ids.message);
      const link = op?.op === "update" ? op.message.linkEmbeds[0] : undefined;
      expect(link?.embed?.["t"]).toBe("Example Article");
    }
  }, { timeout: 20000 });

  test("prioritiseLinksForRead never throws on a DB error (read path stays healthy)", async () => {
    // Regression guard: a DB error (e.g. SQLITE_IOERR_VNODE under I/O
    // pressure) inside filterPendingUrls must be swallowed so getMessages /
    // getMessage never 500 due to embed prioritisation. Embeds are best-effort;
    // messages are the product. A closed DB makes the query throw reliably.
    const { spaceDb } = freshWorker();
    closeDb(); // terminate the worker so every subsequent DB call throws
    await prioritiseLinksForRead(spaceDb, [
      { linkEmbeds: [{ url: "https://example.com/x" }] },
    ]);
  });

  test("sweeper doesn't crash or stream anything when the DB errors mid-drain", async () => {
    // Simulates a failing DB (IOERR_VNODE): seed a pending link, then close
    // the DB so every read/write throws. The loop must back off rather than
    // tight-loop fetch-and-fail, and must emit nothing (no enrichments landed).
    const { globalDb, spaceDb } = freshWorker();
    const { router, signals } = captureRouter();
    await seedLinkMessageRoom(spaceDb, globalDb, {
      room: "01KVRRRRRRRRRRRRRRRRRRRRRR",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url: "https://example.com/broken-db",
    });
    closeDb(); // terminate the worker so every subsequent DB call throws

    await flushSweeper({ globalDb, invalidationRouter: router });
    // Let the loop attempt a cycle and back off.
    await new Promise((r) => setTimeout(r, 300));
    _resetEmbedSweeper();

    expect(signals.find((s) => s.kind === "messageDiff")).toBeUndefined();
  });

  test("definitively-settled (no-data) links are dropped from pending_links so the backlog drains", async () => {
    // Regression: removing only SUCCESSFULLY-enriched URLs from the
    // global `pending_links` index leaves definitive no-data links (page
    // loaded but no OG/oEmbed, or a stable 4xx) pending forever, re-fetched
    // on every sweep — pinning the backlog on dead links and starving real
    // ones.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/no-og";
    await seedLinkMessageRoom(spaceDb, globalDb, {
      room: "01KVRRRRRRRRRRRRRRRRRRRRRR",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url,
    });

    // Mock fetch to return a page with NO OpenGraph/oEmbed metadata → the
    // probe classifies it as definitive "no-data" (settled, not retryable).
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(
        new Response("<html><head><title>No OG here</title></head></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      )) as typeof globalThis.fetch;

    try {
      await flushSweeper({ globalDb, invalidationRouter: router });
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      globalThis.fetch = realFetch;
    }
    _resetEmbedSweeper();

    // The settled no-data link must be removed from the pending set.
    const remaining = await globalDb
      .query("select count(*) as n from pending_links where url = ?")
      .get<{ n: number }>(url);
    expect(remaining?.n ?? 0).toBe(0);
  });

  test("transient failures are parked in backoff so the sweeper doesn't re-fetch them every cycle", async () => {
    // Regression: a transient failure (timeout / 5xx / 429) kept the URL
    // pending AND re-fetched it on every sweep, so a backlog of down links
    // consumed all the concurrency and starved real ones. The sweeper now
    // parks a transient URL for an exponential backoff window, so a second
    // cycle immediately after should NOT re-fetch it.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/flaky";
    await seedLinkMessageRoom(spaceDb, globalDb, {
      room: "01KVRRRRRRRRRRRRRRRRRRRRRR",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url,
    });

    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    // 503 → transient failure.
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      fetchCalls++;
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    }) as typeof globalThis.fetch;

    try {
      // Mark the sweeper started and drive sweepCycle directly (flushSweeper
      // stops/clears state between calls, which would wipe the backoff map).
      // Use _startSweeperNoLoop, NOT startEmbedSweeper: starting the real
      // background loop here races the manual sweepCycle calls via the shared
      // `wake`/`waitForWake` singleton and hangs under parallel-suite CPU
      // contention.
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });

      // First cycle: URL is attempted once and classified transient → parked.
      // (No background loop is running, so sweepCycle fully resolves the
      // fetch + backoff classification before returning — no sleep needed.)
      await sweepCycle(globalDb);
      const afterFirst = fetchCalls;

      // Second cycle: URL is in backoff → must NOT be re-fetched.
      await sweepCycle(globalDb);
      expect(fetchCalls).toBe(afterFirst);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("sweeper advances past a backoff link to enrich a newer one (doesn't stall)", async () => {
    // Regression: the backlog query re-selected the same OLDEST links every
    // cycle, so if the oldest links were all in transient backoff the sweeper
    // filtered them out, got an empty batch, and stalled — never reaching the
    // newer live links behind them. findPendingLinks now excludes backoff URLs
    // in the query, so a newer link is enriched even while an older one is
    // parked.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const oldUrl = "https://example.com/old-flaky";
    const newUrl = "https://example.com/new-live";
    await seedLinkMessageRoom(spaceDb, globalDb, {
      room: "01KVRRRRRRRRRRRRRRRRRRRRRR",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url: oldUrl,
    });
    await seedLinkMessageRoom(spaceDb, globalDb, {
      room: "01KVRRRRRRRRRRRRRRRRRRRRR2",
      message: "01KVNNNNNNNNNNNNNNNNNNNNNN",
      url: newUrl,
    });

    const realFetch = globalThis.fetch;
    // oldUrl → 503 (transient); newUrl → 200 with OG (success).
    globalThis.fetch = ((
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const u = String(input);
      if (u.includes("old-flaky")) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      return Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="New Live" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });

      // Cycle 1: oldUrl is transient → parked in backoff.
      await sweepCycle(globalDb);

      // Cycle 2: oldUrl is in backoff; the sweeper must skip it and enrich
      // newUrl instead (not on an empty batch).
      await sweepCycle(globalDb);

      // newUrl was enriched successfully.
      const newData = await spaceDb
        .query("select embed_json from comp_embed_link_data where entity = ?")
        .get<{ embed_json: string | null }>(newUrl);
      expect(newData?.embed_json).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("backlogStuck flags a backlog that is entirely parked in transient backoff", async () => {
    // A `pending_links` backlog whose every link has already burned through
    // the 1m/5m/30m/2h/6h transient schedule: `inFlight` reads 0 and
    // `dbBackoffActive` is false, so the obvious in-memory signals look idle
    // while the backlog goes nowhere. The stall flag must be set, and the
    // oldest row must be old enough.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/stuck";
    // Seed the row as OLD so it exceeds the stall age threshold.
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    // 503 → transient, so the URL is parked in backoff and stays pending.
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });

      // Cycle 1: attempts the link, classifies transient, parks it.
      await sweepCycle(globalDb);
      expect(embedSweeperStats().backlogStuck).toBe(false);

      // Cycle 2: the backlog is non-empty (the row is still pending) but the
      // only link is in backoff, so nothing is selected — the stall.
      await sweepCycle(globalDb);
      const stats = embedSweeperStats();
      expect(stats.backlogStuck).toBe(true);
      expect(stats.backlogStuckSince).toBeGreaterThan(0);
      expect(stats.backlogStuckSkipped).toBeGreaterThan(0);
      // The parked link is what is holding up the backlog, and it is counted.
      expect(stats.transientBackoff).toBe(1);

      // The row is still in the DB backlog, so `pending` (countPendingLinks)
      // is 1 while the sweeper is doing nothing — the shape the gauge must
      // expose.
      const n = await globalDb
        .query("select count(*) as n from pending_links")
        .get<{ n: number }>();
      expect(n?.n).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a cycle that selects work clears the stall flag", async () => {
    // The stall flag must reflect current reality: once the queue moves (a
    // link is selected for enrichment), the flag clears. Otherwise operators
    // would see a permanently-stuck backlog after a transient dip.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const oldUrl = "https://example.com/clear-old";
    const freshUrl = "https://example.com/clear-fresh";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: oldUrl },
      Date.now() - 60 * 60_000,
    );
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVNNNNNNNNNNNNNNNNNNNNNN", url: freshUrl },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const u = String(input);
      if (u.includes("clear-old")) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      return Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="Cleared" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });

      // Drive the backlog into the stalled state twice so the flag is set.
      await sweepCycle(globalDb); // both links selected; old → parked
      await sweepCycle(globalDb); // fresh link enriched; old still parked
      await sweepCycle(globalDb); // nothing but the parked link left
      expect(embedSweeperStats().backlogStuck).toBe(true);

      // A new link arrives (a fresh poke). The next cycle selects it, which
      // proves the queue is moving — the flag must clear.
      const newUrl = "https://example.com/clear-poked";
      await seedLinkMessageRoom(spaceDb, globalDb, {
        room: "01KVRRRRRRRRRRRRRRRRRRRRR3",
        message: "01KVO000000000000000000000",
        url: newUrl,
      });
      await sweepCycle(globalDb);
      expect(embedSweeperStats().backlogStuck).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });
});

describe("embed sweeper stall reporting", () => {
  test("stall log reports the measured numbers and the all-parked cause", async () => {
    // Regression: the stall warn must not assert a fixed cause ("all
    // pending links are in transient-retry backoff") or publish no numbers.
    // It reports what it measured: the row/URL counts, and a cause derived
    // from them.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/parked";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof globalThis.fetch;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb); // attempts the link → parks it transiently
      warnSpy.mockClear();
      await sweepCycle(globalDb); // selects nothing → stall, logged

      const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) =>
        l.includes("backlog stalled"),
      );
      expect(line).toBeDefined();
      // Numbers, measured — not a fixed parenthetical.
      expect(line).toContain("pendingRows=1");
      expect(line).toContain("selectableRows=0");
      expect(line).toContain("parkedRows=1");
      expect(line).toContain("backoffUrls=1");
      expect(line).toContain("selected=0");
      expect(line).toContain("cause=all-parked");

      // And the same numbers are published for machines (health + gauges).
      const stats = embedSweeperStats();
      expect(stats.lastStallCause).toBe("all-parked");
      expect(stats.lastCycle).toEqual({
        pendingRows: 1,
        selectableRows: 0,
        parkedRows: 1,
        backoffUrls: 1,
        selected: 0,
      });
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the parked/selectable split counts ROWS, so a duplicated URL cannot fake selectable work", async () => {
    // A URL pending in TWO messages yields 2 rows.
    // Parking that one URL parks BOTH rows, so `pending - transientBackoff`
    // (= 2 - 1 = 1) falsely reports a selectable row. The measured split must
    // say selectableRows=0 and blame parking — not a phantom selection bug.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/dup";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url },
      Date.now() - 60 * 60_000,
    );
    // Same URL, second message → a second pending ROW (the URL repeats).
    await globalDb.run(
      "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
      [SPACE_DID, "01KVNNNNNNNNNNNNNNNNNNNNNN", url, Date.now() - 60 * 60_000],
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);
      await sweepCycle(globalDb);

      const stats = embedSweeperStats();
      expect(stats.backlogStuck).toBe(true);
      expect(stats.lastStallCause).toBe("all-parked");
      expect(stats.lastCycle?.pendingRows).toBe(2);
      expect(stats.lastCycle?.selectableRows).toBe(0);
      expect(stats.lastCycle?.parkedRows).toBe(2);
      expect(stats.lastCycle?.backoffUrls).toBe(1);
      // A naive `pendingRows - transientBackoff` subtraction reads 1 here.
      const naive = (stats.lastCycle?.pendingRows ?? 0) - stats.transientBackoff;
      expect(naive).toBe(1);
      expect(stats.lastCycle?.selectableRows).not.toBe(naive);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("classifyStallCause needs an empty probe to claim a selection bug", () => {
    // The rule the stall log branches on. A positive selectable-rows count is
    // NOT sufficient to blame the selection query: rows can land after the
    // selection ran. Only a confirming EMPTY re-run makes it a real bug;
    // otherwise the backlog is selectable and this is not a stall at all.
    expect(classifyStallCause(0, 0)).toBe("all-parked");
    expect(classifyStallCause(0, 5)).toBe("all-parked");
    expect(classifyStallCause(727, 0)).toBe("selectable-but-absent");
    // Rows exist but a re-run finds them → race with in-flight inserts, not a
    // selection bug. Must not be reported as one.
    expect(classifyStallCause(727, 25)).toBe("unknown");
  });

  test("a selection query that misses selectable rows is reported as an ERROR, not blamed on parking", async () => {
    // The wired path for the selectable-but-absent branch. An old PARKED row
    // (so the stall can't be blamed on a fresh, benign backlog) sits alongside
    // an old SELECTABLE row the backlog query fails to return — the exact
    // "selectable rows exist, the query returns none" signature. The stall
    // must be reported as selectable-but-absent (console.error), NOT
    // all-parked.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const parkedUrl = "https://example.com/parked-ghost";
    const selectableUrl = "https://example.com/selectable-ghost";
    const old = Date.now() - 60 * 60_000;
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: parkedUrl },
      old,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      // Only the parked URL fails transiently; the selectable one would enrich
      // fine — but the starved query never returns it.
      if (String(input).includes("parked-ghost")) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      return Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="Ghost" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
    }) as typeof globalThis.fetch;

    // Pass-through proxy; the backlog SELECT (identified by its `order by
    // created_at`) is starved to simulate the bug. Everything else — the
    // min(created_at) probe, the classification aggregate, the deletes — runs
    // normally, so the diagnostic sees the row the selection failed to return.
    const realQuery = globalDb.query.bind(globalDb);
    const shadowed: DbLike = Object.create(globalDb, {
      query: {
        value: (sql: string) =>
          sql.includes("from pending_links") && sql.includes("order by created_at")
            ? realQuery("select space_did, message_id, url from pending_links where 0")
            : realQuery(sql),
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      // Cycle 1 (normal): the parked URL parks itself, removing it from the
      // selectable set. No stall yet.
      await sweepCycle(globalDb);
      expect(embedSweeperStats().backlogStuck).toBe(false);
      // Now add an OLD row that is NOT in the skip set — the row the starved
      // query should return but will not.
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVNNNNNNNNNNNNNNNNNNNNNN", url: selectableUrl },
        old,
      );
      errorSpy.mockClear();
      warnSpy.mockClear();
      // Cycle 2 (starved): the parked URL is in backoff, `selectableUrl` is
      // NOT excluded by the skip set — yet the backlog query returns nothing.
      await sweepCycle(shadowed);

      const errLine = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes("backlog stalled"));
      expect(errLine).toBeDefined();
      expect(errLine).toContain("cause=selectable-but-absent");
      expect(errLine).toContain("selectableRows=1");
      expect(errLine).toContain("parkedRows=1");
      expect(errLine).toContain("selected=0");

      // And it is NOT reported as the expected all-parked stall.
      const parkedLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("cause=all-parked"));
      expect(parkedLines).toEqual([]);

      const stats = embedSweeperStats();
      expect(stats.backlogStuck).toBe(true);
      expect(stats.lastStallCause).toBe("selectable-but-absent");
      expect(stats.lastCycle?.selectableRows).toBe(1);
      expect(stats.lastCycle?.parkedRows).toBe(1);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });
});

describe("embed sweeper retry-state persistence and stall pacing", () => {
  test("a restart restores parked URL backoff from comp_embed_link_data.retry_after", async () => {
    // Defect: the sweeper's transient-retry gate is process-local while
    // the enricher PERSISTS `retry_after`/`attempts`, so a restart without
    // seeding drops all backoff while `pending_links` survives — every parked
    // row becomes selectable at once and the whole backlog is re-fetched. A
    // first cycle after "restart" must select NOTHING when every parked row's
    // window is still open.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/persisted-park";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url },
      Date.now() - 60 * 60_000,
    );
    // The persisted retry state a previous process left behind: a window that
    // is still open, with an escalated attempt count.
    await spaceDb.run(
      `insert into comp_embed_link_data (entity, embed_json, attempts, retry_after)
       values (?, null, 4, ?)`,
      [url, Date.now() + 30 * 60_000],
    );

    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      fetches++;
      return Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="Fetched" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });

      // First cycle of the new process: the restored window must park the URL
      // BEFORE selection, so no fetch happens and the row stays pending.
      await sweepCycle(globalDb);
      expect(fetches).toBe(0);
      const stats = embedSweeperStats();
      expect(stats.transientBackoff).toBe(1);
      const n = await globalDb
        .query("select count(*) as n from pending_links")
        .get<{ n: number }>();
      expect(n?.n).toBe(1);
      // The row was NOT re-fetched, so the persisted attempts survive intact.
      const row = await spaceDb
        .query("select attempts from comp_embed_link_data where entity = ?")
        .get<{ attempts: number }>(url);
      expect(row?.attempts).toBe(4);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("only the expired row is selected — an open retry_after in the future is skipped", async () => {
    // The acceptance case: two rows, one with a future `retry_after`, one
    // expired/null. Only the second may be fetched.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const futureUrl = "https://example.com/still-parked";
    const expiredUrl = "https://example.com/expired-park";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: futureUrl },
      Date.now() - 60 * 60_000,
    );
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVNNNNNNNNNNNNNNNNNNNNNN", url: expiredUrl },
      Date.now() - 60 * 60_000,
    );
    // One window still open; the other expired in the past.
    await spaceDb.run(
      `insert into comp_embed_link_data (entity, embed_json, attempts, retry_after)
       values (?, null, 2, ?)`,
      [futureUrl, Date.now() + 30 * 60_000],
    );
    await spaceDb.run(
      `insert into comp_embed_link_data (entity, embed_json, attempts, retry_after)
       values (?, null, 2, ?)`,
      [expiredUrl, Date.now() - 60_000],
    );

    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      fetched.push(String(input));
      return Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="OK" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);

      expect(fetched.length).toBe(1);
      expect(fetched[0]).toContain("expired-park");
      // The expired row settled and left the backlog; the parked one remains.
      const pending = await globalDb
        .query("select url from pending_links")
        .all<{ url: string }>();
      expect(pending.map((r) => r.url)).toEqual([futureUrl]);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the stall warn is emitted once per cause, not once per flap", async () => {
    // Defect: a log guard comparing against `backlogStuck`-scoped state
    // resets to null on a 1→0→1 flap and re-logs an UNCHANGED cause on every
    // flap. Latching on the cause independently must yield ONE line for a run
    // of cycles whose cause never changes — including cycles that select work
    // but settle nothing.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const flakyUrl = "https://example.com/flaky-flap";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: flakyUrl },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof globalThis.fetch;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb); // parks the link transiently
      warnSpy.mockClear();

      // Drive the stalled state repeatedly. The cause never changes, so the
      // warn latch must keep it to a single line for the whole run.
      for (let i = 0; i < 8; i++) await sweepCycle(globalDb);

      const lines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("backlog stalled"));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("cause=all-parked");
      expect(lines[0]).toContain("stuckTransitions=1");
      // The flap is now countable without a range query.
      expect(embedSweeperStats().backlogStuckTransitions).toBe(1);
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a cycle that selects work but settles no rows does not clear the stall", async () => {
    // The flap driver: when a parked window EXPIRES the link is selected
    // again, fails transiently again, and the backlog is unchanged. Clearing
    // the stall flag on that selection flaps the gauge.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/eternally-flaky";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb); // parks it
      await sweepCycle(globalDb); // selects nothing → stall
      expect(embedSweeperStats().backlogStuck).toBe(true);
      expect(embedSweeperStats().backlogStuckTransitions).toBe(1);

      // A NEW link arrives that will also fail transiently. The next cycle
      // SELECTS it — so the queue is "moving" — but parks it again, settling
      // no rows. Selection alone is not progress: the flag and its counters
      // must persist.
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVNNNNNNNNNNNNNNNNNNNNNN", url: "https://example.com/also-flaky" },
        Date.now() - 60 * 60_000,
      );
      await sweepCycle(globalDb);

      const stats = embedSweeperStats();
      expect(stats.backlogStuck).toBe(true);
      expect(stats.backlogStuckTransitions).toBe(1);
      expect(stats.backlogStuckSince).toBeGreaterThan(0);
      expect(stats.backlogStuckSkipped).toBeGreaterThan(1);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a settled row clears the stall and the next stall is logged again", async () => {
    // The other half of the latch: genuine recovery must clear it, so a
    // re-stall after real recovery is reported again rather than suppressed.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const flakyUrl = "https://example.com/flaky-park";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: flakyUrl },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).includes("flaky-park")) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      return Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="Drained" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
    }) as typeof globalThis.fetch;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb); // parks the flaky link
      await sweepCycle(globalDb); // selects nothing → stall #1
      expect(embedSweeperStats().backlogStuck).toBe(true);
      expect(
        warnSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes("backlog stalled")).length,
      ).toBe(1);

      // RECOVERY: a fresh link enriches and SETTLES, so rows leave the
      // backlog. That is genuine progress and must clear the stall.
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVNNNNNNNNNNNNNNNNNNNNNN", url: "https://example.com/drains-now" },
        Date.now() - 60 * 60_000,
      );
      await sweepCycle(globalDb);
      const stats = embedSweeperStats();
      expect(stats.backlogStuck).toBe(false);
      expect(stats.lastStallCause).toBeNull();
      // One transition in and one out.
      expect(stats.backlogStuckTransitions).toBe(2);

      // A NEW stall must be logged again — recovery cleared the latch.
      warnSpy.mockClear();
      globalThis.fetch = ((
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof globalThis.fetch;
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRR3", message: "01KVO000000000000000000000", url: "https://example.com/re-stall" },
        Date.now() - 60 * 60_000,
      );
      await sweepCycle(globalDb); // parks the new link
      await sweepCycle(globalDb); // stalls on it → stall #2
      const relogged = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("backlog stalled"));
      expect(relogged.length).toBe(1);
      expect(relogged[0]).toContain("cause=all-parked");
      expect(embedSweeperStats().backlogStuckTransitions).toBe(3);
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the idle poll escalates while stalled and returns to the base poll on recovery", async () => {
    // Defect: with every URL parked, `findPendingLinks` returns 0 rows, so
    // the batch is never full and the full-batch throttle can never engage —
    // the loop would take the plain 30s idle branch forever. The stalled
    // poll must back off instead, bounded so an EXPIRING window is still
    // noticed promptly.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const parkedUrl = "https://example.com/poll-parked";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: parkedUrl },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      // Healthy start: the base idle poll.
      expect(sweepIdleDelayMs()).toBe(30_000);

      await sweepCycle(globalDb); // parks the link
      await sweepCycle(globalDb); // selects nothing → stalled
      expect(embedSweeperStats().backlogStuck).toBe(true);
      const stalled = sweepIdleDelayMs();
      expect(stalled).toBeGreaterThan(30_000);

      // More links that will also park, one per cycle: each is selected but
      // settles nothing, so the stall persists and the poll keeps escalating —
      // capped, never past the ceiling.
      for (let i = 0; i < 6; i++) {
        await seedLinkMessageRoom(
          spaceDb,
          globalDb,
          {
            room: `01KVRRRRRRRRRRRRRRRRRRRR${i}`,
            message: `01KVNNNNNNNNNNNNNNNNNNNNN${i}`,
            url: `https://example.com/poll-flaky-${i}`,
          },
          Date.now() - 60 * 60_000,
        );
        await sweepCycle(globalDb);
      }
      expect(sweepIdleDelayMs()).toBe(300_000);
      expect(embedSweeperStats().backlogStuckSkipped).toBeGreaterThanOrEqual(5);

      // RECOVERY: a link that ENRICHES settles its row, so the backlog drains
      // and the poll must return to the base interval immediately.
      globalThis.fetch = ((
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        Promise.resolve(
          new Response(
            '<html><head><meta property="og:title" content="Recovered" /></head></html>',
            { status: 200, headers: { "Content-Type": "text/html" } },
          ),
        )) as typeof globalThis.fetch;
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVOOOOOOOOOOOOOOOOOOOOOO", url: "https://example.com/poll-drains" },
        Date.now() - 60 * 60_000,
      );
      await sweepCycle(globalDb);
      expect(embedSweeperStats().backlogStuck).toBe(false);
      expect(sweepIdleDelayMs()).toBe(30_000);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });
});


describe("embed sweeper cycle pacing (TASK-197)", () => {
  test("sweepYieldsAfter throttles ONLY a full batch that resolved nothing", () => {
    // The rule the loop's pacing branches on. The `if (full) continue` fast
    // path is a deliberate latency optimisation for freshly-posted links, so
    // it must survive: a full batch that produced an `ok` keeps it. A full
    // batch with NO ok is the churn — the loop spent a batch of outbound
    // fetches and resolved nothing — and must yield first.
    const r = (full: boolean, producedOk: boolean): SweepCycleResult => ({ full, producedOk });
    expect(sweepYieldsAfter(r(true, false))).toBe(true);
    expect(sweepYieldsAfter(r(true, true))).toBe(false);
    // An incomplete batch already waits for the idle poll / a poke; it must
    // not be throttled twice.
    expect(sweepYieldsAfter(r(false, false))).toBe(false);
    expect(sweepYieldsAfter(r(false, true))).toBe(false);
  });

  test("counters split a definitive no-data outcome from a transient-retry one", async () => {
    // Regression for TASK-197: one `enrichedNull` counter was incremented for
    // BOTH classes, so "the backlog churns and resolves nothing" was
    // indistinguishable from "the backlog is settling dead links" (which
    // drains: a definitive result DELETES the row). The two must be separate.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const definitiveUrl = "https://example.com/no-og";
    const transientUrl = "https://example.com/flaky";
    await seedLinkMessageRoom(spaceDb, globalDb, {
      room: "01KVRRRRRRRRRRRRRRRRRRRRRR",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url: definitiveUrl,
    });
    await seedLinkMessageRoom(spaceDb, globalDb, {
      room: "01KVRRRRRRRRRRRRRRRRRRRRR2",
      message: "01KVNNNNNNNNNNNNNNNNNNNNNN",
      url: transientUrl,
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).includes("flaky")) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      // Page loads fine but carries no OG/oEmbed and NO <title> → definitive
      // no-data. The <title> matters: `ogToMetadata` falls back to it, so a
      // page carrying one is a title-only `ok`, not a no-data settlement.
      return Promise.resolve(
        new Response("<html><head></head><body>No metadata</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);

      const stats = embedSweeperStats();
      expect(stats.enrichedOk).toBe(0);
      expect(stats.enrichedDefinitive).toBe(1);
      expect(stats.enrichedTransient).toBe(1);
      // `enrichedNull` stays the sum, for the operators/docs that read it.
      expect(stats.enrichedNull).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a definitive no-data batch is not mistaken for churn: it drains the backlog", async () => {
    // The row count is what separates the two classes — a definitive outcome
    // deletes the pending row, a transient one leaves it. Pin it, because the
    // split counters above are only meaningful if this stays true.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/no-og-drain";
    await seedLinkMessageRoom(spaceDb, globalDb, {
      room: "01KVRRRRRRRRRRRRRRRRRRRRRR",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url,
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(
        new Response("<html><head></head><body>No metadata</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      )) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);
      const left = await globalDb
        .query("select count(*) as n from pending_links")
        .get<{ n: number }>();
      expect(left?.n).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the loop yields after a full batch that resolved nothing (the churn bound)", async () => {
    // The mechanism from TASK-197: `if (full) continue;` ran the next backlog
    // batch back-to-back with NO wait, so with a backlog of links that all fail
    // transiently the sweeper fetched at whatever rate the fetches allowed
    // while resolving nothing (production: 360 null/min, enrichedOk flat at 0
    // across 37 samples). With the bound, one full batch of pure failures is
    // followed by a yield, so a 200-link backlog cannot be fetched flat out.
    //
    // The yield is INJECTED, so there is no wall-clock wait: the loop parks
    // there and the assertion is exact — precisely ONE batch was fetched, and
    // most of the backlog is untouched. Without the bound the loop would have
    // kept selecting batches until all 200 links were fetched.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const BACKLOG = 200; // >> SWEEP_BATCH (25), so every batch is full
    for (let i = 0; i < BACKLOG; i++) {
      await seedLinkMessageRoom(spaceDb, globalDb, {
        room: `01KVROOM${String(i).padStart(18, "0")}`,
        message: `01KVMSG${String(i).padStart(19, "0")}`,
        url: `https://example.com/flaky/${i}`,
      });
    }

    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      fetchCalls++;
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    }) as typeof globalThis.fetch;

    // Park forever at the yield: the loop must reach it and stop there.
    const parkState: { at: number | null } = { at: null };
    const park = Promise.withResolvers<void>();
    try {
      await stopEmbedSweeper();
      _setSweepWaitForTest((ms) => {
        parkState.at = ms;
        return park.promise;
      });
      startEmbedSweeper({ globalDb, invalidationRouter: router });
      await settleUntil(() => parkState.at !== null);

      const stats = embedSweeperStats();
      expect(stats.enrichedOk).toBe(0);
      // Exactly one batch was fetched, then the loop yielded for NO_OK_YIELD_MS.
      expect(fetchCalls).toBe(25);
      expect(stats.enrichedTransient).toBe(25);
      expect(stats.sweepCycles).toBe(1);
      expect(stats.sweepThrottled).toBe(1);
      // The bound is the idle-poll interval, so a no-progress batch runs at
      // most once per poll at the default settings.
      expect(parkState.at).toBe(30_000); // IDLE_POLL_MS
      // A transient failure keeps the row pending, so the backlog is still
      // intact — the point is that the loop STOPPED fetching it at one batch.
      const left = await globalDb
        .query("select count(*) as n from pending_links")
        .get<{ n: number }>();
      expect(left?.n).toBe(BACKLOG);
    } finally {
      park.resolve();
      _setSweepWaitForTest(null);
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a full batch that resolves a link keeps the no-wait path", async () => {
    // The other half of the rule, wired: a healthy backlog must still drain
    // flat out, batch after batch with NO wait between them. The injected
    // wait records every call, so "no wait" is asserted, not assumed: the
    // loop must reach the idle poll only after the backlog is empty.
    const { globalDb, spaceDb } = freshWorker();
    const { router } = captureRouter();
    const BACKLOG = 200;
    for (let i = 0; i < BACKLOG; i++) {
      await seedLinkMessageRoom(spaceDb, globalDb, {
        room: `01KVROOM${String(i).padStart(18, "0")}`,
        message: `01KVMSG${String(i).padStart(19, "0")}`,
        url: `https://example.com/good/${i}`,
      });
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="Good" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      )) as typeof globalThis.fetch;

    const waits: number[] = [];
    const park = Promise.withResolvers<void>();
    try {
      await stopEmbedSweeper();
      _setSweepWaitForTest((ms) => {
        waits.push(ms);
        return park.promise;
      });
      startEmbedSweeper({ globalDb, invalidationRouter: router });
      // Wait for the idle poll: the loop must drain all 8 full batches
      // back-to-back with no wait, and only then park.
      await settleUntil(() => waits.length > 0);

      const stats = embedSweeperStats();
      // Every link was enriched, and nothing was throttled.
      expect(stats.enrichedOk).toBe(BACKLOG);
      expect(stats.sweepThrottled).toBe(0);
      // The ONLY wait the loop took was the idle poll, and it came after the
      // backlog was empty — every full batch went straight into the next one.
      expect(waits).toEqual([30_000]);
      // 8 full batches of 25 drained back-to-back, then the final (empty)
      // selection parks on the idle poll.
      expect(stats.sweepCycles).toBe(9);
    } finally {
      park.resolve();
      _setSweepWaitForTest(null);
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });
});
