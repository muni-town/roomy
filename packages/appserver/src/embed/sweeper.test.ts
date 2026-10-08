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
import { countPendingLinks } from "./enricher.ts";
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
afterAll(async () => {
  globalThis.fetch = realFetch;
  // A test that timed out mid-cycle or mid-seed leaves DB requests in flight
  // with no frame left to observe their rejection. Let them settle against the
  // still-open pool before closing it — terminating the worker under them would
  // surface the rejection as an unhandled error outside any test.
  await stopEmbedSweeper();
  await drainSeedWrites();
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
 * A proxy over `globalDb` whose backlog SELECT — the only query that orders by
 * `created_at` — never returns `hiddenUrl`, modelling the selection bug the
 * `selectable-but-absent` class exists for: a row that is pending, stale, and
 * inside no backoff window, yet never selected.
 *
 * Only that one URL is withheld, so every other query (the `min(created_at)`
 * probe, the classification aggregate, the deletes) and every other row behave
 * normally. A cycle that settles unrelated rows therefore leaves the hidden row
 * exactly as it was — still unselected, still unaccounted for — so the fault
 * persists across cycles instead of being consumed by the first selection that
 * happens to take it.
 */
function hideFromSelection(globalDb: DbLike, hiddenUrl: string): DbLike {
  return new Proxy(globalDb, {
    // Every method is bound to the REAL handle: the adapter stores its state in
    // private fields, which a method invoked on the proxy as `this` cannot
    // reach — and the resulting TypeError inside a cycle's delete would look
    // like a DB failure and back the loop off.
    get(target, prop) {
      if (prop === "query") {
        return (sql: string) => {
          const q = target.query(sql);
          if (
            !sql.includes("from pending_links") ||
            !sql.includes("order by created_at")
          ) {
            return q;
          }
          return {
            get: <T,>(...params: unknown[]) => q.get<T>(...params),
            all: async <T,>(...params: unknown[]) =>
              (await q.all<T & { url: string }>(...params)).filter(
                (r) => r.url !== hiddenUrl,
              ),
          };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DbLike;
}

/**
 * Seed writes issued by a test and not yet settled. A test that times out
 * mid-seed has no frame left to await them, so {@link drainSeedWrites} lets
 * the next teardown wait for them to finish against the still-open pool before
 * closing it. Terminating the worker under an in-flight write would reject it,
 * and bun charges a rejection from an abandoned test frame to whatever runs
 * next.
 */
const inFlightSeedWrites = new Set<Promise<unknown>>();

/**
 * Bumped by every {@link freshWorker}. A test body severed by its own timeout
 * keeps running after the timeout has been reported (bun cannot abort it), and
 * its later `expect()` calls would surface as an unhandled error charged
 * between tests. A body that captured the generation can notice teardown has
 * moved on and return instead of asserting against the next test's state.
 */
let workerGeneration = 0;

/**
 * Stop any running sweeper, drain seed writes a timed-out test left in flight,
 * tear down the previous worker, and open a fresh in-memory worker with routed
 * global + per-space handles. Each test gets an isolated set of in-memory DBs.
 */
async function freshWorker(): Promise<{ globalDb: DbLike; spaceDb: DbLike }> {
  workerGeneration++;
  await stopEmbedSweeper();
  await drainSeedWrites();
  closeDb();
  openDb();
  return { globalDb: openGlobalDb(), spaceDb: openSpaceDb(SPACE_DID) };
}

/** The rows that make up one link-in-a-message-in-a-room scenario. */
interface SeedLinkMessageRoom {
  room: string;
  message: string;
  url: string;
}

/**
 * Seed the minimum entity rows for each link-in-a-message-in-a-room scenario
 * in the per-space DB, plus the matching global `pending_links` rows. Writes
 * are issued together: a backlog of several hundred links is routine here, and
 * awaiting each link's round-trips in turn would make the seed, not the code
 * under test, the test's dominant cost.
 */
async function seedLinkMessageRooms(
  spaceDb: DbLike,
  globalDb: DbLike,
  ids: SeedLinkMessageRoom[],
  createdAt?: number,
  spaceDid: string = SPACE_DID,
): Promise<void> {
  const writes = ids.flatMap((id) => [
    // Room entity (its own room column is null — rooms don't belong to rooms).
    spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [
      id.room,
      spaceDid,
    ]),
    // Message entity — room column holds the REAL room id.
    spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      id.message,
      spaceDid,
      id.room,
    ]),
    // Link entity — room column holds the MESSAGE id (not the room id!).
    spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      id.url,
      spaceDid,
      id.message,
    ]),
    spaceDb.run(
      "insert into comp_embed_link (entity, show_preview) values (?, 1)",
      [id.url],
    ),
    // Global pending-links index row (the sweeper's work queue).
    // `createdAt` defaults to now; tests that exercise backlog-stall detection
    // seed an older timestamp to simulate a backlog that has sat untouched.
    globalDb.run(
      "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
      [spaceDid, id.message, id.url, createdAt ?? Date.now()],
    ),
  ]);
  await trackSeedWrites(writes);
}

/** {@link seedLinkMessageRoom} for a single scenario. */
async function seedLinkMessageRoom(
  spaceDb: DbLike,
  globalDb: DbLike,
  ids: SeedLinkMessageRoom,
  createdAt?: number,
  spaceDid: string = SPACE_DID,
): Promise<void> {
  await seedLinkMessageRooms(spaceDb, globalDb, [ids], createdAt, spaceDid);
}

/**
 * Seed one link into the per-space DB and `pending_links`, returning a write
 * that is NOT awaited. Callers batch several of these and settle them together
 * with {@link settleSeedWrites}, so a fixture seeding hundreds of rows costs a
 * handful of round-trips rather than one per link.
 *
 * {@link seedLinkMessageRoom} awaits each of its four writes in turn, which a
 * caller seeding a backlog of a few hundred links spends far more time on than
 * on the code under test.
 */
function seedLinkMessageRoomDeferred(
  spaceDb: DbLike,
  globalDb: DbLike,
  ids: SeedLinkMessageRoom,
  createdAt?: number,
  spaceDid: string = SPACE_DID,
): Promise<unknown>[] {
  return [
    spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [
      ids.room,
      spaceDid,
    ]),
    spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      ids.message,
      spaceDid,
      ids.room,
    ]),
    spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      ids.url,
      spaceDid,
      ids.message,
    ]),
    spaceDb.run(
      "insert into comp_embed_link (entity, show_preview) values (?, 1)",
      [ids.url],
    ),
    globalDb.run(
      "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
      [spaceDid, ids.message, ids.url, createdAt ?? Date.now()],
    ),
  ];
}

/**
 * Remember seed writes until they settle, so {@link drainSeedWrites} can wait
 * for the ones a timed-out test abandoned.
 */
async function trackSeedWrites(writes: Promise<unknown>[]): Promise<void> {
  for (const w of writes) {
    inFlightSeedWrites.add(w);
    void w.then(
      () => inFlightSeedWrites.delete(w),
      () => inFlightSeedWrites.delete(w),
    );
  }
  await settleSeedWrites(writes);
}

/** Wait for every seed write still in flight to settle against the open pool. */
async function drainSeedWrites(): Promise<void> {
  while (inFlightSeedWrites.size > 0) {
    await Promise.allSettled([...inFlightSeedWrites]);
  }
}

/**
 * A past-ceiling (or selectable) pending link at `index`, with the persisted
 * retry state that puts it at `attempts` consecutive transient failures and
 * optionally inside an open backoff window. Builds only the row identifiers —
 * see {@link seedParkedLinks} for the write.
 */
function parkedLinkSeed(
  index: number,
  attempts: number,
  retryAfter: number | null,
): { seed: SeedLinkMessageRoom; attempts: number; retryAfter: number | null } {
  return {
    seed: {
      room: `01KVROOMDEAD${String(index).padStart(14, "0")}`,
      message: `01KVMSGDEAD${String(index).padStart(15, "0")}`,
      url: `https://dead.example/${index}`,
    },
    attempts,
    retryAfter,
  };
}

/**
 * Seed parked links and their retry state in one pass. Returns the URLs in
 * the order given.
 */
async function seedParkedLinks(
  spaceDb: DbLike,
  globalDb: DbLike,
  links: Array<{ seed: SeedLinkMessageRoom; attempts: number; retryAfter: number | null }>,
  spaceDid: string = SPACE_DID,
): Promise<string[]> {
  await seedLinkMessageRooms(
    spaceDb,
    globalDb,
    links.map((l) => l.seed),
    Date.now() - 60 * 60_000,
    spaceDid,
  );
  await trackSeedWrites(
    links.map((l) =>
      spaceDb.run(
        `insert into comp_embed_link_data (entity, embed_json, attempts, retry_after)
         values (?, null, ?, ?)`,
        [l.seed.url, l.attempts, l.retryAfter],
      ),
    ),
  );
  return links.map((l) => l.seed.url);
}

/** {@link seedParkedLinks} for a single parked link. */
async function seedParked(
  spaceDb: DbLike,
  globalDb: DbLike,
  index: number,
  attempts: number,
  retryAfter: number | null,
  spaceDid: string = SPACE_DID,
): Promise<string> {
  const [url] = await seedParkedLinks(
    spaceDb,
    globalDb,
    [parkedLinkSeed(index, attempts, retryAfter)],
    spaceDid,
  );
  return url!;
}

/**
 * A rejection caused by the pool being torn down under an in-flight write —
 * the message the worker's terminate path and the already-closed link both use.
 */
function isTeardownRace(reason: unknown): boolean {
  return /Database is? closed/.test(String(reason));
}

/**
 * Await seed writes without letting a teardown race escape. Every awaited
 * promise must be non-rejecting, not merely observed: a frame abandoned by a
 * timeout has nothing left to catch with, and bun reports a rejection that
 * passes through it as an unhandled error charged to the next test. Each
 * rejection is converted to a value here, and a genuine write failure is
 * re-raised after the await.
 */
async function settleSeedWrites(writes: Promise<unknown>[]): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(
    writes.map((w) =>
      w.catch((err) => {
        if (!isTeardownRace(err)) failures.push(err);
      }),
    ),
  );
  if (failures.length > 0) throw failures[0];
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
    const { globalDb, spaceDb } = await freshWorker();
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
    const { globalDb } = await freshWorker();
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
    const { globalDb, spaceDb } = await freshWorker();
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
    const { spaceDb } = await freshWorker();
    closeDb(); // terminate the worker so every subsequent DB call throws
    await prioritiseLinksForRead(spaceDb, [
      { linkEmbeds: [{ url: "https://example.com/x" }] },
    ]);
  });

  test("sweeper doesn't crash or stream anything when the DB errors mid-drain", async () => {
    // Simulates a failing DB (IOERR_VNODE): seed a pending link, then close
    // the DB so every read/write throws. The loop must back off rather than
    // tight-loop fetch-and-fail, and must emit nothing (no enrichments landed).
    const { globalDb, spaceDb } = await freshWorker();
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
    const { globalDb, spaceDb } = await freshWorker();
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
    const { globalDb, spaceDb } = await freshWorker();
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
    const { globalDb, spaceDb } = await freshWorker();
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

  test("a parked backlog does not latch the flag, however stale its rows are", async () => {
    // A `pending_links` backlog whose every link has burned through the 1m/5m/
    // 30m/2h/6h transient schedule: `inFlight` reads 0 and `dbBackoffActive` is
    // false, so the obvious in-memory signals look idle while the backlog goes
    // nowhere. The flag must still stay down — the empty selection is the
    // correct answer about a queue whose attempts are all already scheduled.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/stuck";
    // Seed the row as OLD so it exceeds the stall age threshold: age alone is
    // NOT what raises the flag.
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
      // only link is in backoff, so nothing is selected. The retry is scheduled
      // and will run when the window expires, so this is not a stall.
      await sweepCycle(globalDb);
      const stats = embedSweeperStats();
      expect(stats.backlogStuck).toBe(false);
      expect(stats.backlogStuckSince).toBe(0);
      expect(stats.backlogStuckSkipped).toBe(0);
      // The parked link is what is holding up the backlog, and it is counted —
      // this is the readout an operator watches instead of the flag.
      expect(stats.transientBackoff).toBe(1);
      expect(stats.parkedAttemptHistogram).toEqual([{ attempts: 1, urls: 1 }]);

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

  test("a trickle of settlements does not clear the stall; a real drain does", async () => {
    // A stalled backlog still SETTLES rows — newly discovered dead links leave
    // a definitive outcome and are deleted — so a cycle that happens to settle
    // one is the normal state of a stuck queue, not recovery. Only a backlog
    // that actually SHRANK past the drain threshold counts, and the log latch
    // must stay silent for the unchanged cause while it has not.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const old = Date.now() - 60 * 60_000;
    // Enough blocked rows that the drain threshold is more than the trickle of
    // one or two settlements the cycles below produce.
    const BLOCKED = 11;
    const blockedUrl = (i: number): string => `https://example.com/trickle-blocked-${i}`;
    for (let i = 0; i < BLOCKED; i++) {
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        {
          room: `01KVRRRRRRRRRRRRRRRRRRRR${i}`,
          message: `01KVNNNNNNNNNNNNNNNNNNNNN${i}`,
          url: blockedUrl(i),
        },
        old,
      );
      // Parked: a window opened by a previous process, still in the future.
      await spaceDb.run(
        `insert into comp_embed_link_data (entity, embed_json, attempts, retry_after)
         values (?, null, 2, ?)`,
        [blockedUrl(i), Date.now() + 30 * 60_000],
      );
    }

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof globalThis.fetch;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });

      // A row NO window accounts for, which the backlog query never returns —
      // the genuine fault the flag exists for, and the stall raised below.
      const ghostUrl = "https://example.com/trickle-ghost";
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        {
          room: "01KVRRRRRRRRRRRRRRRRRRRRZ",
          message: "01KVZZZZZZZZZZZZZZZZZZZZZZ",
          url: ghostUrl,
        },
        old,
      );
      await sweepCycle(hideFromSelection(globalDb, ghostUrl));
      const stalled = embedSweeperStats();
      expect(stalled.backlogStuck).toBe(true);
      expect(stalled.stallBaselineRows).toBe(BLOCKED + 1);
      const stallLines = () =>
        errorSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes("backlog stalled"));
      expect(stallLines().length).toBe(1);

      // Three freshly discovered DEAD links. They are not parked, so the next
      // cycles select and settle them — rows DO leave `pending_links` — but the
      // backlog they leave behind is the same stalled one.
      globalThis.fetch = ((
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> => Promise.resolve(new Response("Gone", { status: 404 }))) as typeof globalThis.fetch;
      const deadWrites: Promise<unknown>[] = [];
      for (let i = 0; i < 3; i++) {
        deadWrites.push(
          ...seedLinkMessageRoomDeferred(
            spaceDb,
            globalDb,
            {
              room: `01KVRRRRRRRRRRRRRRRRRRRR${i}A`,
              message: `01KVO0000000000000000000${i}`,
              url: `https://example.com/trickle-dead-${i}`,
            },
            old,
          ),
        );
      }
      // Settled before the cycles run: a write in flight when a cycle SELECTs
      // would have its row appear later in the same cycle — or leave the promise
      // for whatever test runs next to observe. The hidden row stays hidden, so
      // the stall is NOT recovered by settling the dead links.
      await settleSeedWrites(deadWrites);
      await sweepCycle(hideFromSelection(globalDb, ghostUrl));
      await sweepCycle(hideFromSelection(globalDb, ghostUrl));

      const trickled = embedSweeperStats();
      expect(trickled.enrichedDefinitive).toBeGreaterThan(0);
      expect(await countPendingLinks(globalDb)).toBe(BLOCKED + 1);
      // Settlements happened, the backlog did not move: still stalled, with no
      // extra transition and no second line for the unchanged cause.
      expect(trickled.backlogStuck).toBe(true);
      expect(trickled.stallBaselineRows).toBe(BLOCKED + 1);
      expect(trickled.stallDrainTarget).toBeGreaterThan(1);
      expect(trickled.backlogStuckTransitions).toBe(
        stalled.backlogStuckTransitions,
      );
      expect(stallLines().length).toBe(1);
    } finally {
      errorSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the drain bar is the backlog the stall was raised on, not a drifting one", async () => {
    // Re-measuring the threshold as the queue moves would let a backlog that
    // grew and then fell part-way back clear itself: a stall raised at 4 that
    // saw the backlog reach 10 and fall to 7 has not drained, yet 7 is below a
    // fresh tenth-of-peak bar. The bar stays at the size the stall was raised
    // on, so the trickle off a GROWN queue cannot clear it either.
    //
    // The stall is raised by a starved selection: rows no window accounts for go
    // unselected. The parked rows that keep arriving alongside it are what makes
    // the backdrop real.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const old = Date.now() - 60 * 60_000;
    const url = (i: number): string => `https://example.com/baseline-${i}`;
    const seed = async (i: number): Promise<void> => {
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        {
          room: `01KVRRRRRRRRRRRRRRRRRRRR${i}`,
          message: `01KVNNNNNNNNNNNNNNNNNNNNN${i}`,
          url: url(i),
        },
        old,
      );
      await spaceDb.run(
        `insert into comp_embed_link_data (entity, embed_json, attempts, retry_after)
         values (?, null, 2, ?)`,
        [url(i), Date.now() + 30 * 60_000],
      );
    };
    for (let i = 0; i < 4; i++) await seed(i);
    // A row no window accounts for, which the backlog query never returns: the
    // fault the stall is raised on, sitting alongside the parked rows.
    const ghostUrl = "https://example.com/baseline-ghost";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      {
        room: "01KVRRRRRRRRRRRRRRRRRRRRZ",
        message: "01KVZZZZZZZZZZZZZZZZZZZZZZ",
        url: ghostUrl,
      },
      old,
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
      await sweepCycle(hideFromSelection(globalDb, ghostUrl)); // hidden row → stall
      expect(embedSweeperStats().backlogStuck).toBe(true);
      expect(embedSweeperStats().stallBaselineRows).toBe(5);
      expect(embedSweeperStats().stallDrainTarget).toBe(1);

      // The backlog grows to 10 while stalled — new links keep arriving and
      // park too. The selection stays hidden so the stall is NOT accidentally
      // recovered by a cycle that settles every selectable row.
      for (let i = 4; i < 10; i++) await seed(i);
      await sweepCycle(hideFromSelection(globalDb, ghostUrl));
      expect(embedSweeperStats().backlogStuck).toBe(true);

      // Six of them leave, taking the backlog back to the 5 it was raised on.
      // Six settled rows is real work, but the queue is exactly as stuck as
      // when the stall began, so it is NOT recovery.
      await globalDb.run(
        `delete from pending_links where url in (?, ?, ?, ?, ?, ?)`,
        [url(4), url(5), url(6), url(7), url(8), url(9)],
      );
      await sweepCycle(hideFromSelection(globalDb, ghostUrl));

      const stats = embedSweeperStats();
      expect(await countPendingLinks(globalDb)).toBe(5);
      expect(stats.backlogStuck).toBe(true);
      expect(stats.backlogStuckTransitions).toBe(1);

      // The fault clears: the hidden row leaves `pending_links` (another writer
      // settled it), taking the backlog below the bar, so the stall clears.
      await globalDb.run(`delete from pending_links where url = ?`, [ghostUrl]);
      await sweepCycle(globalDb);
      expect(await countPendingLinks(globalDb)).toBe(4);
      expect(embedSweeperStats().backlogStuck).toBe(false);
      expect(embedSweeperStats().backlogStuckTransitions).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });
});

describe("embed sweeper stall reporting", () => {
  test("a stall reports the measured numbers, and only a selection bug reports one", async () => {
    // Regression: the stall error must not assert a fixed cause ("all
    // pending links are in transient-retry backoff") or publish no numbers.
    // It reports what it measured: the row/URL counts, and the cause derived
    // from them.
    //
    // The cause here is the selection failing to return a row the backoff set
    // does not account for — the only shape that raises the flag. A parked
    // backlog alone does NOT (see the all-parked test above), so the starved
    // selection is what makes this cycle a stall.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const url = "https://example.com/unselected";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(hideFromSelection(globalDb, url)); // selects nothing → stall

      const line = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes("backlog stalled"));
      expect(line).toBeDefined();
      // Numbers, measured — not a fixed parenthetical.
      expect(line).toContain("pendingRows=1");
      expect(line).toContain("selectableRows=1");
      expect(line).toContain("parkedRows=0");
      expect(line).toContain("backoffUrls=0");
      expect(line).toContain("selected=0");
      expect(line).toContain("cause=selectable-but-absent");

      // And the same numbers are published for machines (health + gauges).
      const stats = embedSweeperStats();
      expect(stats.lastStallCause).toBe("selectable-but-absent");
      expect(stats.lastCycle).toEqual({
        pendingRows: 1,
        selectableRows: 1,
        parkedRows: 0,
        backoffUrls: 0,
        selected: 0,
      });
      expect(stats.backlogStuck).toBe(true);
    } finally {
      errorSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the parked/selectable split counts ROWS, so a duplicated URL cannot fake selectable work", async () => {
    // A URL pending in TWO messages yields 2 rows, while the sweeper's backoff
    // gate is keyed by URL. Parking two URLs where one of them repeats therefore
    // parks 3 ROWS behind 2 gate entries, so `pendingRows - transientBackoff`
    // (= 4 - 2 = 2) matches neither the parked rows (3) nor the selectable ones
    // (1). The measured split must count rows on both sides.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const dupUrl = "https://example.com/dup";
    const old = Date.now() - 60 * 60_000;
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: dupUrl },
      old,
    );
    // Same URL, second message → a second pending ROW (the URL repeats).
    await globalDb.run(
      "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
      [SPACE_DID, "01KVNNNNNNNNNNNNNNNNNNNNNN", dupUrl, old],
    );
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVO000000000000000000000", url: "https://example.com/solo" },
      old,
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
      // Cycle 1: both URLs fail transiently, so all THREE rows park behind the
      // two gate entries.
      await sweepCycle(globalDb);
      // A row no window accounts for, added after the selection ran, so the
      // starved cycle below still finds it: the fault the stall is raised on.
      const ghostUrl = "https://example.com/dup-ghost";
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRRZ", message: "01KVZZZZZZZZZZZZZZZZZZZZZZ", url: ghostUrl },
        old,
      );
      await sweepCycle(hideFromSelection(globalDb, ghostUrl));

      const stats = embedSweeperStats();
      expect(stats.backlogStuck).toBe(true);
      expect(stats.lastStallCause).toBe("selectable-but-absent");
      expect(stats.lastCycle?.pendingRows).toBe(4);
      expect(stats.lastCycle?.parkedRows).toBe(3);
      expect(stats.lastCycle?.selectableRows).toBe(1);
      // ONE gate entry covers the duplicated URL, so the URL-keyed count is 2
      // while the rows it parks are 3 — the unit mismatch that made a parked
      // backlog read as selectable work.
      expect(stats.transientBackoff).toBe(2);
      expect(stats.lastCycle?.parkedRows).not.toBe(stats.transientBackoff);
      const naive = (stats.lastCycle?.pendingRows ?? 0) - stats.transientBackoff;
      expect(naive).toBe(2);
      expect(naive).not.toBe(stats.lastCycle?.parkedRows);
      expect(naive).not.toBe(stats.lastCycle?.selectableRows);
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

  test("a backlog whose rows are all inside their backoff windows is a schedule, not a stall", async () => {
    // The shape the flag used to latch on for hours: a stale backlog whose
    // EVERY row is parked. Every attempt is already scheduled, so the empty
    // selection is correct, the queue drains as windows expire, and nothing
    // needs an operator — the state is reported by `parkedAttemptHistogram`,
    // and `backlogStuck` must stay up only for a fault.
    //
    // Live this read `pending 1, transientBackoff 1, parkedAttemptHistogram
    // [{attempts: 5, urls: 1}], backlogStuck true, backlogStuckSkipped 1271`:
    // one row two hours into a six-hour window, with the flag up for the whole
    // of it and 1271 escalated cycles spent re-deriving the same numbers.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    // One URL pending in TWO messages — two ROWS — parked at attempt 5 through
    // its persisted retry state. The parked split is counted in ROWS while the
    // gate is keyed by URL, so a duplicated URL parks both rows behind one gate
    // entry and must not read as a selectable row (the unit mismatch that made
    // this flag look justified).
    const url = "https://example.com/all-parked";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url },
      Date.now() - 60 * 60_000,
    );
    await globalDb.run(
      "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
      [SPACE_DID, "01KVNNNNNNNNNNNNNNNNNNNNNN", url, Date.now() - 60 * 60_000],
    );
    await trackSeedWrites([
      spaceDb.run(
        `insert into comp_embed_link_data (entity, embed_json, attempts, retry_after)
         values (?, null, 5, ?)`,
        [url, Date.now() + 2 * 60 * 60_000],
      ),
    ]);

    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      fetches++;
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    }) as typeof globalThis.fetch;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      // Cycles 1 and 2: nothing is selectable (both rows are parked), and the
      // rows are stale, so the diagnostic runs and measures the split.
      await sweepCycle(globalDb);
      await sweepCycle(globalDb);

      // The window is still open two hours out, so nothing is even attempted.
      expect(fetches).toBe(0);
      const stats = embedSweeperStats();
      expect(await countPendingLinks(globalDb)).toBe(2);
      expect(stats.transientBackoff).toBe(1);
      expect(stats.parkedAttemptHistogram).toEqual([{ attempts: 5, urls: 1 }]);
      // The schedule, not a fault.
      expect(stats.backlogStuck).toBe(false);
      expect(stats.backlogStuckSince).toBe(0);
      expect(stats.backlogStuckSkipped).toBe(0);
      expect(stats.backlogStuckTransitions).toBe(0);
      // Nothing is latched, so nothing is published as a cause either.
      expect(stats.lastStallCause).toBeNull();
      expect(stats.lastCycle).toBeNull();

      // No cycle may spend the ERROR path on a retry schedule, and no cycle
      // may flap the flag: the counters stay at zero across repeated cycles.
      // Both rows are parked, so nothing is ever selected or settled — the
      // window is what holds the queue, exactly as it does for hours in
      // production.
      expect(
        warnSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes("backlog stalled")),
      ).toEqual([]);
      for (let i = 0; i < 5; i++) await sweepCycle(globalDb);
      expect(await countPendingLinks(globalDb)).toBe(2);
      expect(embedSweeperStats().backlogStuckTransitions).toBe(0);
      expect(embedSweeperStats().backlogStuck).toBe(false);
      expect(embedSweeperStats().backlogStuckSince).toBe(0);
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a selection query that misses selectable rows is reported as an ERROR, not blamed on parking", async () => {
    // The wired path for the selectable-but-absent branch. An old SELECTABLE
    // row the backlog query fails to return, next to an old PARKED one — the
    // exact "selectable rows exist (so no window accounts for them), the query
    // returns none" signature. Nothing in the queue will move that row, so this
    // is the stall the flag exists for, and it must be reported as
    // selectable-but-absent (console.error), NOT as parking.
    const { globalDb, spaceDb } = await freshWorker();
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
      await sweepCycle(hideFromSelection(globalDb, selectableUrl));

      const errLine = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.includes("backlog stalled"));
      expect(errLine).toBeDefined();
      expect(errLine).toContain("cause=selectable-but-absent");
      expect(errLine).toContain("selectableRows=1");
      expect(errLine).toContain("parkedRows=1");
      expect(errLine).toContain("selected=0");

      // And it is NOT reported as parking.
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
    const { globalDb, spaceDb } = await freshWorker();
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
    const { globalDb, spaceDb } = await freshWorker();
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

  test("the stall error is emitted once per cause, not once per flap", async () => {
    // The cause is latched independently of the stall flag: the flag's own
    // fields are refreshed by every stalled cycle, so a guard reading them
    // would re-log an UNCHANGED cause. A run of cycles whose cause never
    // changes must produce ONE line.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const flakyUrl = "https://example.com/flaky-flap";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: flakyUrl },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      fetchCount++;
      if (fetchCount === 1) {
        return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
      }
      return Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="F" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      );
    }) as typeof globalThis.fetch;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      const ghostUrl = "https://example.com/flaky-ghost";
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVNNNNNNNNNNNNNNNNNNNNNN", url: ghostUrl },
        Date.now() - 60 * 60_000,
      );

      // Drive the stalled state repeatedly. The cause never changes, so the
      // error latch must keep it to a single line for the whole run.
      for (let i = 0; i < 8; i++) {
        await sweepCycle(hideFromSelection(globalDb, ghostUrl));
      }

      const lines = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("backlog stalled"));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("cause=selectable-but-absent");
      expect(lines[0]).toContain("stuckTransitions=1");
      // The flap is now countable without a range query.
      expect(embedSweeperStats().backlogStuckTransitions).toBe(1);
    } finally {
      errorSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a cycle that selects work but settles no rows does not clear the stall", async () => {
    // The flap driver: when a parked window EXPIRES the link is selected
    // again, fails transiently again, and the backlog is unchanged. Clearing
    // the stall flag on that selection flaps the gauge.
    const { globalDb, spaceDb } = await freshWorker();
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
      await sweepCycle(globalDb); // parks the flaky URL
      // An old row no window accounts for, planted while the selection is
      // starved: the fault the stall is raised on, left in place by every cycle
      // below because none of them can select it.
      const ghostUrl = "https://example.com/eternally-ghost";
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRR2", message: "01KVNNNNNNNNNNNNNNNNNNNNNN", url: ghostUrl },
        Date.now() - 60 * 60_000,
      );
      await sweepCycle(hideFromSelection(globalDb, ghostUrl)); // selects nothing → stall
      expect(embedSweeperStats().backlogStuck).toBe(true);
      expect(embedSweeperStats().backlogStuckTransitions).toBe(1);

      // A NEW link arrives that will also fail transiently. The next cycle
      // SELECTS it — so the queue is "moving" — but parks it again, settling
      // no rows. Selection alone is not progress: the flag and its counters
      // must persist.
      const alsoFlakyUrl = "https://example.com/also-flaky";
      await trackSeedWrites(
        seedLinkMessageRoomDeferred(
          spaceDb,
          globalDb,
          { room: "01KVRRRRRRRRRRRRRRRRRRRRR3", message: "01KVO000000000000000000000", url: alsoFlakyUrl },
          Date.now() - 60 * 60_000,
        ),
      );
      await sweepCycle(hideFromSelection(globalDb, ghostUrl));

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

  test("a genuine drain clears the stall and the next stall is reported again", async () => {
    // The other half of the latch: recovery must clear it, so a re-stall after
    // real recovery is reported again rather than suppressed. Recovery is the
    // backlog DRAINING — a backlog that only settles a row without shrinking is
    // still stalled (see the trickle test).
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const ghostUrl = "https://example.com/ghost-park";
    const reStallUrl = "https://example.com/re-stall";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: ghostUrl },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="G" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      )) as typeof globalThis.fetch;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(hideFromSelection(globalDb, ghostUrl)); // row unselected → stall #1
      expect(embedSweeperStats().backlogStuck).toBe(true);
      expect(
        errorSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes("backlog stalled")).length,
      ).toBe(1);

      // RECOVERY: the row leaves `pending_links` (another writer settled it, or
      // an operator purged it), so the backlog the stall describes is gone.
      await globalDb.run(`delete from pending_links`);
      await sweepCycle(globalDb);
      const stats = embedSweeperStats();
      expect(await countPendingLinks(globalDb)).toBe(0);
      expect(stats.backlogStuck).toBe(false);
      expect(stats.lastStallCause).toBeNull();
      // One transition in and one out.
      expect(stats.backlogStuckTransitions).toBe(2);

      // A NEW stall must be reported again — recovery cleared the latch.
      errorSpy.mockClear();
      await seedLinkMessageRoom(
        spaceDb,
        globalDb,
        { room: "01KVRRRRRRRRRRRRRRRRRRRRR3", message: "01KVO000000000000000000000", url: reStallUrl },
        Date.now() - 60 * 60_000,
      );
      await sweepCycle(hideFromSelection(globalDb, reStallUrl)); // stalls on it → stall #2
      const relogged = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("backlog stalled"));
      expect(relogged.length).toBe(1);
      expect(relogged[0]).toContain("cause=selectable-but-absent");
      expect(embedSweeperStats().backlogStuckTransitions).toBe(3);
    } finally {
      errorSpy.mockRestore();
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the idle poll escalates while stalled and returns to the base poll on recovery", async () => {
    // Defect: a stalled cycle selects no rows, so the batch is never full and
    // the full-batch throttle can never engage — the loop would take the plain
    // 30s idle branch forever, re-running the diagnostic and repeating the same
    // ERROR line at full rate. The stalled poll must back off instead, bounded
    // so it is still re-measured regularly.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const ghostUrl = "https://example.com/poll-ghost";
    await seedLinkMessageRoom(
      spaceDb,
      globalDb,
      { room: "01KVRRRRRRRRRRRRRRRRRRRRRR", message: "01KVMMMMMMMMMMMMMMMMMMMMMM", url: ghostUrl },
      Date.now() - 60 * 60_000,
    );

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(
        new Response(
          '<html><head><meta property="og:title" content="P" /></head></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      )) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      // Healthy start: the base idle poll.
      expect(sweepIdleDelayMs()).toBe(30_000);

      await sweepCycle(hideFromSelection(globalDb, ghostUrl)); // selects nothing → stalled
      expect(embedSweeperStats().backlogStuck).toBe(true);
      const stalled = sweepIdleDelayMs();
      expect(stalled).toBeGreaterThan(30_000);

      // More old rows the hidden row keeps the stall on: each cycle selects one
      // and parks it (nothing settles), so the stall persists and the poll keeps
      // escalating — capped, never past the ceiling. The seeds are batched: a
      // write still in flight when the cycle runs would be an insert racing the
      // cycle's own SELECT, and bun charges the unsettled promise to whichever
      // test runs next.
      const moreWrites: Promise<unknown>[] = [];
      for (let i = 0; i < 9; i++) {
        moreWrites.push(
          ...seedLinkMessageRoomDeferred(
            spaceDb,
            globalDb,
            {
              room: `01KVRRRRRRRRRRRRRRRRRRRR${i}`,
              message: `01KVNNNNNNNNNNNNNNNNNNNNN${i}`,
              url: `https://example.com/poll-flaky-${i}`,
            },
            Date.now() - 60 * 60_000,
          ),
        );
        await settleSeedWrites(moreWrites.splice(0));
        await sweepCycle(hideFromSelection(globalDb, ghostUrl));
      }
      expect(sweepIdleDelayMs()).toBe(300_000);
      expect(embedSweeperStats().backlogStuckSkipped).toBeGreaterThanOrEqual(5);

      // RECOVERY: the hidden row leaves the backlog (another writer settled it),
      // so the stall clears and the poll returns to the base interval
      // immediately.
      await globalDb.run(`delete from pending_links where url = ?`, [ghostUrl]);
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
    const { globalDb, spaceDb } = await freshWorker();
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
    const { globalDb, spaceDb } = await freshWorker();
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
    const { globalDb, spaceDb } = await freshWorker();
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
    const { globalDb, spaceDb } = await freshWorker();
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

describe("settling rows already past the attempt ceiling (TASK-257)", () => {
  test("a past-ceiling row parked in an open backoff window is settled WITHOUT a fetch", async () => {
    // The residue TASK-227 left: a URL past the ceiling is skipped by the
    // backlog query while its window is open, so the only thing that settles
    // it is the window expiring and the row being re-fetched from a host
    // already measured as gone — thousands of rows, ~6h each, to reach the
    // branch that discards them. The settle must happen in the classification
    // pass, from the recorded retry state, with no outbound request.
    //
    // The assertion is the FETCH COUNT, not the resulting state: a state-only
    // assertion passes on the old drain too, because the re-fetch settles the
    // row in the end. Counting fetches is what distinguishes "settled now"
    // from "settled after one more doomed round-trip".
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const url = await seedParked(spaceDb, globalDb, 0, 40, Date.now() + 6 * 60 * 60_000);

    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((_input: RequestInfo | URL) => {
      fetches++;
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);

      // No outbound request reached the dead host.
      expect(fetches).toBe(0);
      // And the row is settled and out of the backlog all the same.
      expect(await countPendingLinks(globalDb)).toBe(0);
      const stats = embedSweeperStats();
      expect(stats.enrichedAbandoned).toBe(1);
      expect(stats.enrichedTransient).toBe(0);
      // The persisted row is settled exactly as the ceiling fetch path leaves
      // it: null embed, no retry schedule, the attempt count preserved.
      const row = await spaceDb
        .query("select embed_json, attempts, retry_after from comp_embed_link_data where entity = ?")
        .get<{ embed_json: string | null; attempts: number; retry_after: number | null }>(url);
      expect(row?.embed_json).toBeNull();
      expect(row?.attempts).toBe(40);
      expect(row?.retry_after).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a below-ceiling row is left parked and fetched by nobody", async () => {
    // The other half: the settle must not touch a URL that still has retries
    // to spend. It stays in the backlog, in its window, and is not fetched.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    await seedParked(spaceDb, globalDb, 0, 2, Date.now() + 6 * 60 * 60_000);

    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((_input: RequestInfo | URL) => {
      fetches++;
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);

      expect(fetches).toBe(0);
      expect(await countPendingLinks(globalDb)).toBe(1);
      const stats = embedSweeperStats();
      expect(stats.enrichedAbandoned).toBe(0);
      expect(stats.parkedFinalAttempt).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the whole past-ceiling backlog drains in ONE cycle, and the live set still enriches", async () => {
    // The drain-rate claim: production held 7,798 over-ceiling rows draining
    // at ~120 rows/h (~65h) because each was re-fetched. Here a past-ceiling
    // set spanning multiple settle chunks, plus a selectable live link, must
    // leave the backlog in one pass — with the live link still fetched and
    // enriched, i.e. the settle does not consume the batch or starve real work.
    const { globalDb, spaceDb } = await freshWorker();
    // Captured after this test's own `freshWorker()`; a later bump means a
    // subsequent test has already torn this one's worker down.
    const generation = workerGeneration;
    const { router } = captureRouter();
    // 450 past-ceiling rows — enough to span many settle chunks — plus one
    // selectable live link, seeded in one pass. The past-ceiling rows carry the
    // attempt count that parks them; the live link starts at zero attempts and
    // is selectable.
    const DEAD = 450;
    const dead = await seedParkedLinks(
      spaceDb,
      globalDb,
      [
        ...Array.from({ length: DEAD }, (_, i) =>
          parkedLinkSeed(i, 40, Date.now() + 6 * 60 * 60_000),
        ),
        parkedLinkSeed(9999, 0, null),
      ],
      SPACE_DID,
    );
    // A timeout would have severed this body during the seed; the assertions
    // below would then read the NEXT test's worker. Stop here instead.
    if (workerGeneration !== generation) return;
    const live = dead.pop()!;

    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetches++;
      const url = String(input);
      if (url === live) {
        return Promise.resolve(
          new Response(FAKE_HTML, { status: 200, headers: { "Content-Type": "text/html" } }),
        );
      }
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);
      // Same guard: a timeout may have severed this body inside the cycle.
      if (workerGeneration !== generation) return;
      // Only the live link was fetched — none of the past-ceiling rows.
      expect(fetches).toBe(1);
      expect(await countPendingLinks(globalDb)).toBe(0);
      const stats = embedSweeperStats();
      expect(stats.enrichedAbandoned).toBe(DEAD);
      expect(stats.enrichedOk).toBe(1);
      expect(stats.enrichedTransient).toBe(0);
      expect(stats.parkedOverCeiling).toBe(0);
      // Every dead row is settled in its space DB, none left mid-state.
      const settled = await spaceDb
        .query(
          `select count(*) as n from comp_embed_link_data
            where retry_after is null and embed_json is null`,
        )
        .get<{ n: number }>();
      expect(settled?.n).toBe(DEAD);
      expect(dead.length).toBe(DEAD);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
  }, 15000);

  test("a past-ceiling URL pending in two spaces settles both spaces' rows", async () => {
    // The gate is URL-keyed while the backlog is row-keyed. Settling only the
    // space the URL was first seen in would orphan the other space's row in
    // `pending_links` forever, since the gate entry that made it selectable is
    // gone.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const OTHER = "did:web:other.example";
    const otherSpaceDb = openSpaceDb(OTHER);
    const url = await seedParked(spaceDb, globalDb, 0, 40, Date.now() + 6 * 60 * 60_000);
    await seedLinkMessageRoom(
      otherSpaceDb,
      globalDb,
      { room: "01KVROOMOTHER000000000000", message: "01KVMSGOTHER0000000000000", url },
      Date.now() - 60 * 60_000,
      OTHER,
    );
    await otherSpaceDb.run(
      `insert into comp_embed_link_data (entity, embed_json, attempts, retry_after)
       values (?, null, 40, ?)`,
      [url, Date.now() + 6 * 60 * 60_000],
    );

    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((_input: RequestInfo | URL) => {
      fetches++;
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    }) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);

      expect(fetches).toBe(0);
      expect(await countPendingLinks(globalDb)).toBe(0);
      expect(embedSweeperStats().enrichedAbandoned).toBe(1);
      for (const db of [spaceDb, otherSpaceDb]) {
        const row = await db
          .query("select embed_json, retry_after from comp_embed_link_data where entity = ?")
          .get<{ embed_json: string | null; retry_after: number | null }>(url);
        expect(row?.retry_after).toBeNull();
        expect(row?.embed_json).toBeNull();
      }

      // A second cycle finds nothing left to settle: the gate entries are gone
      // with the rows, so the dead set is not re-counted or re-written.
      await sweepCycle(globalDb);
      expect(fetches).toBe(0);
      expect(embedSweeperStats().enrichedAbandoned).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });
});

describe("embed attempt ceiling (TASK-227)", () => {
  test("a host that keeps failing transiently leaves pending_links instead of being retried forever", async () => {
    // The defect: a host that is permanently gone but answers with a 5xx can
    // never classify as definitive, so backoff parks it at the 6h cap and
    // re-fetches it forever while the backlog never drains. A URL whose
    // attempt count has run past any ceiling must be SETTLED (leave
    // `pending_links`) rather than re-queued at an unchanged cap.
    //
    // Seeded past the ceiling rather than on it, so this is exactly the
    // inherited dead set: attempts persisted by a build that had no ceiling.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const url = await seedParked(spaceDb, globalDb, 0, 40, Date.now() - 60_000);

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

      // The dead host is out of the backlog — the whole point.
      expect(await countPendingLinks(globalDb)).toBe(0);

      // It is reported as an abandoned host, not as a retry.
      const stats = embedSweeperStats();
      expect(stats.enrichedAbandoned).toBe(1);
      expect(stats.enrichedTransient).toBe(0);
      // And its persisted row carries no retry schedule, so nothing re-queues
      // it if the link is seen again.
      const row = await spaceDb
        .query("select retry_after from comp_embed_link_data where entity = ?")
        .get<{ retry_after: number | null }>(url);
      expect(row?.retry_after).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("a host below the ceiling is still retried, not abandoned", async () => {
    // The other half: the ceiling must not settle a merely slow host. A URL
    // with attempts left must stay pending with a retry scheduled.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const url = await seedParked(spaceDb, globalDb, 0, 1, Date.now() - 60_000);

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

      expect(await countPendingLinks(globalDb)).toBe(1);
      const stats = embedSweeperStats();
      expect(stats.enrichedAbandoned).toBe(0);
      expect(stats.enrichedTransient).toBe(1);
      const row = await spaceDb
        .query("select attempts, retry_after from comp_embed_link_data where entity = ?")
        .get<{ attempts: number; retry_after: number | null }>(url);
      expect(row?.attempts).toBe(2);
      expect(row?.retry_after).not.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });

  test("the parked set is reported by attempt count, with the dead set separable", async () => {
    // `transientBackoff` is one number for a queue of slow hosts and a queue of
    // dead ones. These fields are what make an "all-parked" backlog
    // attributable to a SET: the distribution says where the parked URLs sit on
    // the schedule, and `parkedOverCeiling` isolates the inherited dead set (a
    // build with no ceiling persisted attempts past the new one).
    //
    // The classification pass settles that inherited set, so a cycle reports it
    // as `enrichedAbandoned` — read against `parkedOverCeiling`, the pair says
    // how much of the parked population was dead rather than slow.
    const { globalDb, spaceDb } = await freshWorker();
    const { router } = captureRouter();
    const open = Date.now() + 30 * 60_000;
    // Parked at 1, at 2 (twice), and at 40 — an attempt count no sane ceiling
    // admits, so it is past the ceiling whatever the ceiling is configured to.
    for (const [i, attempts] of [1, 2, 2, 40].entries()) {
      await seedParked(spaceDb, globalDb, i, attempts!, open);
    }

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> =>
      Promise.resolve(new Response("", { status: 200, headers: { "Content-Type": "text/html" } }))) as typeof globalThis.fetch;

    try {
      await stopEmbedSweeper();
      _startSweeperNoLoop({ globalDb, invalidationRouter: router });
      await sweepCycle(globalDb);

      // The three below-ceiling rows are the parked population that remains,
      // with the distribution that says where on the schedule they sit.
      const stats = embedSweeperStats();
      expect(stats.transientBackoff).toBe(3);
      expect(stats.parkedAttemptHistogram).toEqual([
        { attempts: 1, urls: 1 },
        { attempts: 2, urls: 2 },
      ]);
      expect(stats.parkedFinalAttempt).toBe(0);
      // The one past-ceiling row is reported as settled rather than retried.
      expect(stats.parkedOverCeiling).toBe(0);
      expect(stats.enrichedAbandoned).toBe(1);
      expect(await countPendingLinks(globalDb)).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
      await stopEmbedSweeper();
    }
    _resetEmbedSweeper();
  });
});
