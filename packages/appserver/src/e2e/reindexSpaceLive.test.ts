/**
 * LIVE end-to-end verification: space.roomy.admin.reindexSpace against a REAL
 * Qdrant server over HTTP.
 *
 * Not a CI test — it needs a running Qdrant, so it skips itself when none is
 * reachable. It exists to prove the full repair path with real infrastructure:
 * real HTTP appserver, real SQLite materialisation, real
 * @qdrant/js-client-rest over the network, real BM25 encode + query. That is
 * the check the fake-Qdrant e2e tests cannot make.
 *
 * Reproduces the production condition — a space whose backfill cursor has
 * advanced PAST messages absent from the index, which the background sweeper
 * therefore never revisits — runs the real admin procedure, then asserts the
 * skipped messages are searchable through the real search path.
 *
 * Usage:
 *   1. Start Qdrant:  docker run -d --rm -p 6333:6333 qdrant/qdrant:v1.12.4
 *   2. Run:           QDRANT_URL=http://127.0.0.1:6333 \
 *                       bun test --cwd packages/appserver src/e2e/reindexSpaceLive.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { ulidFactory } from "@roomy-space/sdk";
import { QdrantClient } from "@qdrant/js-client-rest";
import { startAppserver, materializeSpace, type E2eContext } from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";
import { flushSearchQueue } from "../search/indexer.ts";
import { startSearchBackfill, stopSearchBackfill, sweepCycle } from "../search/backfill.ts";
import { encodeSparse } from "../search/bm25.ts";
import {
  _setQdrantClientForTest,
  _resetQdrantClient,
  type QdrantClientLike,
} from "../search/qdrantSearch.ts";

// Opt-in only. This suite needs a real Qdrant AND mutates the process-global
// QDRANT_URL, so it must never run as part of the normal suite (a Qdrant that
// merely happens to be listening would otherwise change the behaviour of
// unrelated search tests — e.g. the "503 when Qdrant is not configured" case).
const LIVE = process.env.QDRANT_LIVE === "1";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const USER = "did:plc:e2e-user";
const ADMIN = "did:plc:e2e-admin";
const SPACE = "did:web:reindex-live.example";
const MESSAGES = 250;

_setAdminDids([ADMIN]);

/**
 * The real QdrantClient's signatures are wider than QdrantClientLike (it
 * accepts an options arg on every method), so the structural match needs one
 * assertion. The interface is the codebase's own seam for exactly this.
 */
function asQdrantClientLike(client: QdrantClient): QdrantClientLike {
  return client as unknown as QdrantClientLike;
}

let reachable = false;
beforeAll(async () => {
  if (!LIVE) return;
  try {
    reachable = (await fetch(`${QDRANT_URL}/`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    reachable = false;
  }
});
afterAll(() => {
  _resetQdrantClient();
  delete process.env.QDRANT_URL;
});

/** Minimal typed handle to the e2e appserver's routed global DB. */
interface GlobalDbHandle {
  query(sql: string): { get<T>(...p: unknown[]): Promise<T | null> };
  run(sql: string, ...p: unknown[]): Promise<{ changes: number }>;
}

/**
 * Run the background sweeper's own cycle a fixed number of times. Proves the
 * sweeper alone leaves a space whose cursor is past unindexed messages
 * untouched (it selects no rows, so nothing is re-indexed).
 */
async function sweepToQuiescence(globalDb: GlobalDbHandle): Promise<number> {
  startSearchBackfill({ globalDb: globalDb as never });
  try {
    let cycles = 0;
    for (let i = 0; i < 10; i++) {
      await sweepCycle(globalDb as never);
      cycles++;
    }
    return cycles;
  } finally {
    await stopSearchBackfill();
  }
}

describe("LIVE reindexSpace against real Qdrant", () => {
  test("repairs a space whose cursor advanced past unindexed messages", async () => {
    if (!LIVE) {
      console.warn("SKIP: set QDRANT_LIVE=1 to run the real-Qdrant verification");
      return;
    }
    if (!reachable) {
      console.warn(`SKIP: no Qdrant reachable at ${QDRANT_URL}`);
      return;
    }

    // Inject the real client directly rather than setting QDRANT_URL: the
    // env var is process-global and would leak into sibling test files.
    _resetQdrantClient();

    // Real network Qdrant, injected as the process-wide client.
    const real = new QdrantClient({ url: QDRANT_URL, port: 6333 });
    _setQdrantClientForTest(asQdrantClientLike(real));
    // Fresh collection so the run is hermetic and repeatable.
    await real.deleteCollection("messages").catch(() => {});

    const ctx: E2eContext = await startAppserver();

    // 250 messages through the real write path (≤50 events/request).
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "verification message number 0 unique0",
    });
    // Real monotonic ULIDs (the server validates the id shape).
    const nextUlid = ulidFactory();
    const targetId = { value: "" };
    for (let batch = 0; batch < 5; batch++) {
      const events = [];
      for (let i = batch * 50 + 1; i < Math.min((batch + 1) * 50 + 1, MESSAGES); i++) {
        const id = nextUlid();
        if (i === 42) targetId.value = id;
        events.push({
          id,
          $type: "space.roomy.message.createMessage.v0",
          room: roomId,
          body: {
            mimeType: "text/plain",
            data: { $bytes: Buffer.from(`verification message number ${i} unique${i}`).toString("base64") },
          },
          extensions: {},
        });
      }
      const res = await ctx.authedFetch(USER)(
        `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
        { method: "POST", body: JSON.stringify({ spaceId: SPACE, events }) },
      );
      if (res.status !== 200) throw new Error(`sendEvents ${res.status}: ${await res.text()}`);
    }
    // The live indexer already upserted these as they were sent. To reproduce
    // the condition faithfully the index must be genuinely EMPTY while the
    // cursor sits past every message — otherwise the repair under test has
    // nothing to repair and the assertion is vacuous. Delete the points and
    // let the queue drain so no late upsert re-adds them behind our back.
    await flushSearchQueue();
    await real.delete("messages", {
      filter: { must: [{ key: "spaceDid", match: { value: SPACE } }] },
    });
    await flushSearchQueue();

    // Cursor PAST every message: the background sweeper reads the space as
    // caught up and never revisits it.
    const globalDb = (ctx.db as unknown as { global(): GlobalDbHandle }).global();
    await globalDb.run("delete from search_backfill_cursor where space_did = ?", [SPACE]);
    await globalDb.run(
      "insert into search_backfill_cursor (space_did, cursor, updated_at) values (?, ?, ?)",
      [SPACE, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", Date.now()],
    );
    const before = await real.count("messages", {
      filter: { must: [{ key: "spaceDid", match: { value: SPACE } }] },
      exact: true,
    });
    console.log(`[live] index at start (must be 0): ${before.count} points`);
    expect(before.count).toBe(0);

    // Why the existing tools cannot fix this: the background sweeper, run by
    // itself against this state, does nothing — the cursor reads as caught up,
    // so it selects no rows for this space. This is the property that makes a
    // targeted reset (rather than waiting on the sweeper) necessary.
    const cyclesRan = await sweepToQuiescence(globalDb);
    const afterSweeper = await real.count("messages", {
      filter: { must: [{ key: "spaceDid", match: { value: SPACE } }] },
      exact: true,
    });
    console.log(
      `[live] sweeper-only repair attempt: ${cyclesRan} cycles -> ${afterSweeper.count} points (hole NOT repaired)`,
    );
    expect(afterSweeper.count).toBe(0);

    // ── The real admin procedure, over real HTTP ──
    const res = await ctx.authedFetch(ADMIN)(
      `${ctx.baseUrl}/xrpc/space.roomy.admin.reindexSpace`,
      { method: "POST", body: JSON.stringify({ spaceId: SPACE }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      indexed: number;
      drained: boolean;
      failed: number;
      cycles: number;
    };
    console.log("[live] reindexSpace ->", JSON.stringify(body));

    expect(body.indexed).toBe(MESSAGES);
    expect(body.drained).toBe(true);
    expect(body.failed).toBe(0);

    // ── Verify in real Qdrant: every message indexed, and the skipped
    //    message is retrievable by a real BM25 query ──
    const after = await real.count("messages", {
      filter: { must: [{ key: "spaceDid", match: { value: SPACE } }] },
      exact: true,
    });
    console.log(`[live] indexed points after: ${after.count}`);
    expect(after.count).toBe(MESSAGES);

    const hits = await real.query("messages", {
      query: encodeSparse("verification unique42") as never,
      using: "bm25",
      filter: { must: [{ key: "spaceDid", match: { value: SPACE } }] },
      limit: 5,
      with_payload: true,
    });
    const positive = hits.points.filter((p) => p.score > 0);
    console.log(`[live] query "verification unique42" -> ${positive.length} hits`);
    for (const h of positive.slice(0, 3)) {
      console.log(`   score=${h.score.toFixed(4)} messageId=${String(h.payload?.messageId)}`);
    }
    expect(positive.length).toBeGreaterThan(0);
    expect(String(positive[0]?.payload?.messageId)).toBe(targetId.value);
  }, 120_000);
});
