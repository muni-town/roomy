import { beforeAll, afterAll, describe, expect, test } from "bun:test";

import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  startEmbedSweeper,
  prioritiseLinksForRead,
  sweepCycle,
  _resetEmbedSweeper,
  _startSweeperNoLoop,
  stopEmbedSweeper,
  type EmbedSweeperOpts,
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
  await globalDb.run(
    "insert into pending_links (space_did, message_id, url, created_at) values (?, ?, ?, ?)",
    [SPACE_DID, ids.message, ids.url, Date.now()],
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

    // Every emitted signal must be a #messageDiff update targeting the real
    // ROOM id (not the message id) with an update op keyed on the message id.
    for (const sig of signals) {
      expect(sig.kind).toBe("messageDiff");
      if (sig.kind === "messageDiff") {
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
    }

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
    // backfill, never write-poked) used to sit behind the entire backlog.
    // The read handler now calls prioritiseLinksForRead so they jump the queue.
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
    // Regression: the sweeper only removed SUCCESSFULLY-enriched URLs from the
    // global `pending_links` index. Definitive no-data links (page loaded but
    // no OG/oEmbed, or a stable 4xx) stayed pending forever and were re-fetched
    // on every sweep, pinning the backlog on dead links and starving real ones
    // (production showed enrichedOk: 0 with a 30k+ backlog that never drained).
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
});
