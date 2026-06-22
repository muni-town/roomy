import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDb } from "../db/db.ts";
import {
  startEmbedSweeper,
  _resetEmbedSweeper,
  type EmbedSweeperOpts,
} from "./sweeper.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
} from "../invalidation/types.ts";

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
  test("emits getMessages with the real room id, not the message id", async () => {
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

    // Every emitted signal must target getMessages with roomId = the ROOM id.
    for (const sig of signals) {
      expect(sig.kind).toBe("queryInvalidation");
      if (sig.kind === "queryInvalidation") {
        expect(sig.signal.nsid).toBe("space.roomy.room.getMessages");
        expect(sig.signal.params.roomId).toBe(ids.room);
      }
    }

    // Explicitly assert the bug is fixed: the message id must NOT appear.
    const paramRoomIds = signals
      .filter((s) => s.kind === "queryInvalidation")
      .map((s) => (s.kind === "queryInvalidation" ? s.signal.params.roomId : null));
    expect(paramRoomIds).not.toContain(ids.message);
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
});
