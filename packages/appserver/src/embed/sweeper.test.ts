import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDb } from "../db/db.ts";
import {
  startEmbedSweeper,
  prioritiseLinksForRead,
  _resetEmbedSweeper,
  type EmbedSweeperOpts,
} from "./sweeper.ts";
import type { Embed } from "./types.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
} from "../invalidation/types.ts";

// Deterministic fake embed so the sweeper test doesn't depend on the
// network or a live embed service. The sweeper only emits a #messageDiff
// when enrichment SUCCEEDS (non-null embed), so the mock must return data.
const FAKE_EMBED: Embed = {
  v: "1",
  ts: "2026-06-23T00:00:00Z",
  ty: "link",
  u: "https://example.com/article",
  t: "Example Article",
  d: "A test embed.",
};
const FAKE_RESPONSE = JSON.stringify(["2026-06-23T00:00:00Z", FAKE_EMBED]);
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = ((
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> =>
    Promise.resolve(
      new Response(FAKE_RESPONSE, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
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

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

/** Seed the minimum entity rows for a link-in-a-message-in-a-room scenario. */
function seedLinkMessageRoom(
  db: Database,
  ids: { room: string; message: string; url: string },
): void {
  // Room entity (its own room column is null — rooms don't belong to rooms).
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    ids.room,
    "did:web:test.example",
  ]);
  // Message entity — room column holds the REAL room id.
  db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    ids.message,
    "did:web:test.example",
    ids.room,
  ]);
  // Link entity — room column holds the MESSAGE id (not the room id!).
  // This mirrors both ensureEntity(streamId, url, event.id) for explicit
  // link attachments and detectAndStoreLinks(db, messageId, content).
  db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    ids.url,
    "did:web:test.example",
    ids.message,
  ]);
  db.run(
    "insert into comp_embed_link (entity, show_preview) values (?, 1)",
    [ids.url],
  );
}

/**
 * Drive the sweeper through one pending batch synchronously. The sweeper is
 * a detached async loop; for testing we start it, poke it, then poll the
 * captured signals until enrichment (a mock fetch) resolves and the
 * invalidation fires.
 */
async function flushSweeper(opts: EmbedSweeperOpts): Promise<void> {
  startEmbedSweeper(opts);
}

describe("embed sweeper invalidation room resolution", () => {
  test("emits a #messageDiff update with the real room id, not the message id", async () => {
    const db = freshDb();
    const { router, signals } = captureRouter();
    const ids = {
      room: "01KVQQQQQQQQQQQQQQQQQQQQQQ",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url: "https://example.com/article",
    };
    seedLinkMessageRoom(db, ids);

    await flushSweeper({ db, invalidationRouter: router });

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
  });

  test("does not emit when no pending links exist", async () => {
    const db = freshDb();
    const { router, signals } = captureRouter();

    await flushSweeper({ db, invalidationRouter: router });

    // Let the loop idle once.
    await new Promise((r) => setTimeout(r, 100));
    _resetEmbedSweeper();

    expect(signals.length).toBe(0);
  });

  test("read-driven prioritisation enriches a viewed message's pending link", async () => {
    // Regression: links in messages a user is READING (detected during
    // backfill, never write-poked) used to sit behind the entire backlog.
    // The read handler now calls prioritiseLinksForRead so they jump the queue.
    const db = freshDb();
    const { router, signals } = captureRouter();
    const ids = {
      room: "01KVRRRRRRRRRRRRRRRRRRRRRR",
      message: "01KVMMMMMMMMMMMMMMMMMMMMMM",
      url: "https://example.com/read-viewed",
    };
    seedLinkMessageRoom(db, ids);

    // Simulate the getMessages handler: prioritise the viewed message's links.
    // Called BEFORE the sweeper is started (as it would be on a cold read).
    prioritiseLinksForRead(db, [{ linkEmbeds: [{ url: ids.url }] }]);

    await flushSweeper({ db, invalidationRouter: router });

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
  });
});
