/**
 * E2E coverage for space.roomy.search.messages (Qdrant-backed, Phase 2).
 *
 * These tests materialize a space through the REAL write path
 * (`space.roomy.space.sendEvents` → applyBatch → per-space DB + search
 * enqueue), with an in-memory FAKE Qdrant injected via the client
 * singleton — hermetic, no network, no staging dependency. After each send,
 * the search queue is flushed so results are deterministic.
 *
 * Covered: hit finding, read-access filtering, min-query-length validation,
 * cursor pagination, empty results, and search-unavailable (Qdrant disabled).
 *
 * Run: bun test --cwd packages/appserver src/e2e/search.test.ts
 */

import { describe, expect, test, beforeEach, vi } from "bun:test";
import type { Database } from "bun:sqlite";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  materializeSpace,
  seedSpace,
  spaceDb,
  type E2eContext,
} from "./helpers.ts";
import { _setQdrantClientForTest, _resetQdrantClient, type QdrantClientLike } from "../search/qdrantSearch.ts";
import { flushSearchQueue } from "../search/indexer.ts";
import { startSearchBackfill, stopSearchBackfill, sweepCycle, _resetSearchBackfill, searchBackfillStats } from "../search/backfill.ts";
import type { SparseVector } from "../search/bm25.ts";

const USER = "did:plc:e2e-user";
const VISITOR = "did:plc:e2e-visitor";
const SPACE = "did:web:search-e2e.example";

function get(ctx: E2eContext, path: string) {
  return ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/${path}`);
}

// ─── In-memory fake Qdrant ───────────────────────────────────────────────

interface FakePoint {
  id: string;
  vector: { [name: string]: SparseVector };
  payload: Record<string, unknown>;
}

/** Minimal Qdrant: filtered sparse scoring, pagination, collection mgmt. */
class FakeQdrant implements QdrantClientLike {
  exists = true;
  points: FakePoint[] = [];

  async collectionExists(_name: string): Promise<{ exists: boolean }> {
    return { exists: this.exists };
  }
  async createCollection(_name: string, _args: unknown): Promise<unknown> {
    this.exists = true;
    return {};
  }
  async createPayloadIndex(_name: string, _args: unknown): Promise<unknown> {
    return {};
  }
  async upsert(_name: string, args: unknown): Promise<unknown> {
    const { points } = args as {
      points: Array<{
        id: string;
        vector: Record<string, SparseVector>;
        payload: Record<string, unknown>;
      }>;
    };
    for (const p of points) {
      const idx = this.points.findIndex((q) => q.id === p.id);
      const point = { id: p.id, vector: p.vector, payload: p.payload };
      if (idx >= 0) this.points[idx] = point;
      else this.points.push(point);
    }
    return {};
  }
  async delete(_name: string, args: unknown): Promise<unknown> {
    const { points } = args as { points: string[] };
    this.points = this.points.filter((p) => !points.includes(p.id));
    return {};
  }
  async query(
    _name: string,
    args: unknown,
  ): Promise<{
    points: Array<{ id: unknown; score: number; payload?: Record<string, unknown> | null }>;
  }> {
    const { query, using, filter, limit, offset = 0 } = args as {
      query: SparseVector;
      using: string;
      filter?: { must?: Array<{ key: string; match: { any?: string[] } }> };
      limit: number;
      offset?: number;
    };
    if (using !== "bm25") throw new Error("wrong vector name");

    const spaceDids = new Set<string>();
    for (const cond of filter?.must ?? []) {
      if (cond.key === "spaceDid" && cond.match?.any) {
        for (const v of cond.match.any) spaceDids.add(v);
      }
    }

    const scored: Array<{ id: string; score: number; payload: Record<string, unknown> }> = [];
    const qm = new Map<number, number>();
    for (let i = 0; i < query.indices.length; i++) {
      qm.set(query.indices[i]!, query.values[i]!);
    }
    for (const p of this.points) {
      if (spaceDids.size > 0 && !spaceDids.has(p.payload.spaceDid as string)) continue;
      const doc = p.vector[using];
      if (!doc) continue;
      let score = 0;
      for (let i = 0; i < doc.indices.length; i++) {
        const qv = qm.get(doc.indices[i]!);
        if (qv !== undefined) score += qv * doc.values[i]!;
      }
      if (score > 0) scored.push({ id: p.id, score, payload: p.payload });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const page = scored.slice(offset, offset + limit);
    return { points: page.map((p) => ({ id: p.id, score: p.score, payload: p.payload })) };
  }
  async count(_name: string, args?: unknown): Promise<{ count: number }> {
    const filter = (args as { filter?: { must?: Array<{ key: string; match: { value?: string } }> } })?.filter;
    let count = this.points.length;
    if (filter?.must) {
      for (const cond of filter.must) {
        if (cond.key === "spaceDid" && cond.match?.value) {
          count = this.points.filter((p) => p.payload.spaceDid === cond.match!.value).length;
        }
      }
    }
    return { count };
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────

async function sendMessage(
  ctx: E2eContext,
  roomId: string,
  text: string,
): Promise<string> {
  const messageId = newUlid();
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          {
            id: messageId,
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: {
              mimeType: "text/plain",
              data: { $bytes: Buffer.from(text).toString("base64") },
            },
            extensions: {},
          },
        ],
      }),
    },
  );
  if (res.status !== 200) {
    throw new Error(`sendMessage failed ${res.status}: ${await res.text()}`);
  }
  await flushSearchQueue();
  return messageId;
}

async function sendReply(
  ctx: E2eContext,
  roomId: string,
  targetId: string,
  text: string,
): Promise<string> {
  const messageId = newUlid();
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          {
            id: messageId,
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: {
              mimeType: "text/plain",
              data: { $bytes: Buffer.from(text).toString("base64") },
            },
            extensions: {
              "space.roomy.extension.attachments.v0": {
                $type: "space.roomy.extension.attachments.v0",
                attachments: [
                  {
                    $type: "space.roomy.attachment.reply.v0",
                    target: targetId,
                  },
                ],
              },
            },
          },
        ],
      }),
    },
  );
  if (res.status !== 200) {
    throw new Error(`sendReply failed ${res.status}: ${await res.text()}`);
  }
  await flushSearchQueue();
  return messageId;
}

async function sendRoom(ctx: E2eContext, name: string): Promise<string> {
  const roomId = newUlid();
  const res = await ctx.authedFetch(USER)(
    `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      body: JSON.stringify({
        spaceId: SPACE,
        events: [
          {
            id: roomId,
            $type: "space.roomy.room.createRoom.v0",
            kind: "space.roomy.channel",
            name,
          },
        ],
      }),
    },
  );
  if (res.status !== 200) {
    throw new Error(`createRoom failed ${res.status}: ${await res.text()}`);
  }
  return roomId;
}

async function newAppWithQdrant(): Promise<{ ctx: E2eContext; fake: FakeQdrant }> {
  const ctx = await startAppserver();
  const fake = new FakeQdrant();
  _setQdrantClientForTest(fake);
  return { ctx, fake };
}

describe("space.roomy.search.messages (Qdrant)", () => {
  beforeEach(() => {
    _resetQdrantClient();
  });

  test("search finds a materialized message", async () => {
    const { ctx } = await newAppWithQdrant();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });
    await flushSearchQueue();

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=brown`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    expect(body.messages[0].content).toContain("brown");
  });

  test("search respects room read access", async () => {
    const { ctx } = await newAppWithQdrant();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "open forum discussion",
    });
    await sendMessage(ctx, roomId, "another open message");

    // A second, restricted room (default_access = none) with a message.
    const secretRoom = await sendRoom(ctx, "secret");
    await sendMessage(ctx, secretRoom, "secret pineapple recipe");
    await spaceDb(ctx.db, SPACE).run(
      "update comp_room set default_access = 'none' where entity = ?",
      [secretRoom],
    );

    // Admin (USER) sees everything.
    const adminRes = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=pineapple`);
    expect(adminRes.status).toBe(200);
    const adminBody = await adminRes.json();
    expect(adminBody.messages.some((m: { content: string }) => m.content.includes("secret"))).toBe(true);

    // A public-join visitor sees the open room but not the restricted one.
    const visitorRes = await ctx.authedFetch(VISITOR)(
      `${ctx.baseUrl}/xrpc/space.roomy.search.messages?spaceId=${SPACE}&q=pineapple`,
    );
    expect(visitorRes.status).toBe(200);
    const visitorBody = await visitorRes.json();
    expect(visitorBody.messages.some((m: { content: string }) => m.content.includes("secret"))).toBe(false);
    const openRes = await ctx.authedFetch(VISITOR)(
      `${ctx.baseUrl}/xrpc/space.roomy.search.messages?spaceId=${SPACE}&q=forum`,
    );
    const openBody = await openRes.json();
    expect(openBody.messages.length).toBeGreaterThanOrEqual(1);
  });

  test("rejects queries shorter than 3 characters", async () => {
    const { ctx } = await newAppWithQdrant();
    await materializeSpace(ctx, SPACE, USER, { messageText: "hello world" });

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=ab`);
    expect(res.status).toBe(400);
  });

  test("paginates with a cursor", async () => {
    const { ctx } = await newAppWithQdrant();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "alpha page test one",
    });
    await sendMessage(ctx, roomId, "alpha page test two");
    await sendMessage(ctx, roomId, "alpha page test three");

    const page1 = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=page&limit=2`);
    expect(page1.status).toBe(200);
    const body1 = await page1.json();
    expect(body1.messages).toHaveLength(2);
    expect(typeof body1.cursor).toBe("string");

    const page2 = await get(
      ctx,
      `space.roomy.search.messages?spaceId=${SPACE}&q=page&limit=2&cursor=${encodeURIComponent(body1.cursor)}`,
    );
    expect(page2.status).toBe(200);
    const body2 = await page2.json();
    expect(body2.messages).toHaveLength(1);
    expect(body2.cursor).toBeUndefined();

    const ids = [...body1.messages.map((m: { id: string }) => m.id), body2.messages[0].id];
    expect(new Set(ids).size).toBe(3);
  });

  test("paginates one-at-a-time through all matches (limit=1)", async () => {
    const { ctx } = await newAppWithQdrant();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "alpha page test one",
    });
    await sendMessage(ctx, roomId, "alpha page test two");
    await sendMessage(ctx, roomId, "alpha page test three");

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const url = `space.roomy.search.messages?spaceId=${SPACE}&q=page&limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const res = await get(ctx, url);
      expect(res.status).toBe(200);
      const body = await res.json();
      if (body.messages.length === 0) break; // window exhausted
      expect(body.messages).toHaveLength(1);
      seen.push(body.messages[0].id);
      if (body.cursor === undefined) break;
      cursor = body.cursor;
    }

    // All three matches walked exactly once, in order.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  test("cursor terminates after the window is exhausted (full-window case)", async () => {
    const { ctx } = await newAppWithQdrant();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "alpha page test one",
    });
    // More matches than the window (limit=2 → window=6): 8 messages. The
    // window is the searchable cap — only 6 are ever returned.
    for (let i = 2; i <= 8; i++) {
      await sendMessage(ctx, roomId, `alpha page test message number ${i}`);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let emptyPages = 0;
    for (let i = 0; i < 12; i++) {
      const url = `space.roomy.search.messages?spaceId=${SPACE}&q=page&limit=2${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const res = await get(ctx, url);
      expect(res.status).toBe(200);
      const body = await res.json();
      if (body.messages.length === 0) {
        emptyPages++;
        // The trailing cursor may resolve to one empty page, but the
        // cursor must terminate — it must not keep advancing forever.
        if (body.cursor === undefined) break;
        expect(emptyPages).toBeLessThanOrEqual(1);
      } else {
        seen.push(...body.messages.map((m: { id: string }) => m.id));
      }
      if (body.cursor === undefined) break;
      cursor = body.cursor;
    }

    // All window-capped matches walked exactly once, and the walk terminated.
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(emptyPages).toBeLessThanOrEqual(1);
  });

  test("empty result set returns 200 with no messages", async () => {
    const { ctx } = await newAppWithQdrant();
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox" });

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=zzzznotfound`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  test("returns 503 when Qdrant is not configured", async () => {
    const ctx = await startAppserver();
    await materializeSpace(ctx, SPACE, USER, { messageText: "hello world" });
    await flushSearchQueue();

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=hello`);
    expect(res.status).toBe(503);
  });

  test("cross-space search (spaceId omitted) searches all joined spaces", async () => {
    const { ctx } = await newAppWithQdrant();
    const SPACE2 = "did:web:search-e2e-two.example";
    await materializeSpace(ctx, SPACE, USER, { messageText: "cross space alpha" });
    await materializeSpace(ctx, SPACE2, USER, { messageText: "cross space beta" });
    await flushSearchQueue();

    // Without spaceId the handler searches every space the caller joined.
    const res = await get(ctx, `space.roomy.search.messages?q=cross`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);

    // Each result carries the room/space it was found in.
    const spaceDids = new Set(body.messages.map((m: { spaceId: string }) => m.spaceId));
    expect(spaceDids.has(SPACE)).toBe(true);
    expect(spaceDids.has(SPACE2)).toBe(true);
    for (const m of body.messages) {
      expect(typeof m.roomId).toBe("string");
      expect(typeof m.spaceId).toBe("string");
    }
  });

  test("per-space search results carry roomId/spaceId context", async () => {
    const { ctx } = await newAppWithQdrant();
    await materializeSpace(ctx, SPACE, USER, { messageText: "contextual pineapple" });
    await flushSearchQueue();

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=pineapple`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    expect(body.messages[0].spaceId).toBe(SPACE);
    expect(typeof body.messages[0].roomId).toBe("string");
  });

  test("search results carry denormalised reply context", async () => {
    const { ctx } = await newAppWithQdrant();
    const { roomId } = await materializeSpace(ctx, SPACE, USER, {
      messageText: "original pineapple",
    });
    await flushSearchQueue();
    const searchRes = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=original`);
    const searchBody = (await searchRes.json()) as { messages: Array<{ id: string }> };
    const originalId = searchBody.messages[0]!.id;

    // A reply carrying a reply attachment materialises a `reply` edge.
    await sendReply(ctx, roomId, originalId, "replied pineapple");
    await flushSearchQueue();

    const res = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=replied`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    for (const m of body.messages) {
      expect(m.reply).toBeDefined();
      expect(typeof m.reply.messageId).toBe("string");
      // The reply target is embedded fully hydrated — no client fetch needed.
      expect(typeof m.reply.message?.id).toBe("string");
      expect(m.reply.message.content).toContain("original");
    }

    // A hit with no replyTo carries no reply field.
    const originalRes = await get(ctx, `space.roomy.search.messages?spaceId=${SPACE}&q=original`);
    const originalBody = await originalRes.json();
    expect(originalBody.messages.length).toBeGreaterThanOrEqual(1);
    for (const m of originalBody.messages) {
      expect(m.reply).toBeUndefined();
    }
  });

});
describe("backfill sweeper (Qdrant)", () => {
  beforeEach(() => {
    _resetQdrantClient();
  });

  test("an empty space does not starve the backfill sweeper", async () => {
    const { ctx, fake } = await newAppWithQdrant();
    // Space A: entity_space entry + space entity, but NO messages. It sorts
    // before the message space in nextCursorSpace (cursor-less = updated_at
    // 0), so without the fix it is picked forever and the message space is
    // never backfilled.
    const EMPTY = "did:web:aaa-empty.example";
    seedSpace(ctx.db as unknown as Database, EMPTY, USER, {
      allowPublicJoin: 1,
    });
    // Space B: one message.
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox jumps" });
    await flushSearchQueue();
    const pointsBefore = fake.points.length;

    const globalDb = (ctx.db as unknown as {
      global(): { query(sql: string): { get<T>(...p: unknown[]): Promise<T | null> } };
    }).global();
    _resetSearchBackfill();
    startSearchBackfill({ globalDb: globalDb as never });
    try {
      // Cycle 0: picks the empty space (no rows → stamps a cursor).
      // Cycle 1: picks the message space and indexes its message.
      // The message was already indexed by the live indexer, so the sweep's
      // upsert is idempotent (points don't grow) — what matters is that the
      // sweeper REACHES the message space (backfilled > 0) instead of being
      // stuck on the empty space forever.
      await sweepCycle(globalDb as never);
      await sweepCycle(globalDb as never);
    } finally {
      await stopSearchBackfill();
    }

    expect(searchBackfillStats().backfilled).toBeGreaterThan(0);
  });

  test("sweep cycles emit structured progress telemetry", async () => {
    const { ctx } = await newAppWithQdrant();
    // Capture the progress lines emitted by sweepCycle via the Loki sink.
    // The e2e appserver replaces the sink? No — it doesn't. Capture stdout
    // instead: the progress line is `[search-backfill] progress` at info
    // level, one JSON object per line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const EMPTY = "did:web:aaa-empty.example";
    seedSpace(ctx.db as unknown as Database, EMPTY, USER, { allowPublicJoin: 1 });
    await materializeSpace(ctx, SPACE, USER, { messageText: "the quick brown fox jumps" });
    await flushSearchQueue();

    const globalDb = (ctx.db as unknown as {
      global(): { query(sql: string): { get<T>(...p: unknown[]): Promise<T | null> } };
    }).global();
    _resetSearchBackfill();
    startSearchBackfill({ globalDb: globalDb as never });
    let progressLines: string[] = [];
    try {
      await sweepCycle(globalDb as never);
      await sweepCycle(globalDb as never);
      // Snapshot BEFORE restore — mockRestore() wipes recorded calls.
      progressLines = infoSpy.mock.calls
        .map((c) => c[0] as string)
        .filter((l) => typeof l === "string" && l.includes('"scope":"search-backfill"'));
    } finally {
      await stopSearchBackfill();
      infoSpy.mockRestore();
    }

    expect(progressLines.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(progressLines[progressLines.length - 1]!);
    expect(last.msg).toContain("progress");
    expect(typeof last.spaceDid).toBe("string");
    expect(typeof last.cursor).toBe("string");
    expect(typeof last.rows).toBe("number");
    expect(typeof last.indexed).toBe("number");
    expect(typeof last.backfilled).toBe("number");
    expect(typeof last.errorCount).toBe("number");
    expect(typeof last.dbBackoffActive).toBe("boolean");
  });

  test(
    "empty spaces rotate; a 250-message space is fully backfilled",
    // Heaviest test in the file: boots an appserver, pushes 250 messages
    // through the real HTTP write path, then runs 30 sweep cycles. 0.5s
    // locally, but CI runners under full-suite parallel load blow the 5s
    // default — same pattern as the WS sync tests.
    async () => {
      const { ctx } = await newAppWithQdrant();
      // Two empty spaces (entity_space entries, no messages) + one message
      // space with 250 messages (needs 3 sweep visits at SWEEP_BATCH=100).
      // Without the updated_at refresh on 0-row visits, the sweeper stamps
      // both empty spaces then re-picks the oldest-stamped one forever,
      // stalling at 100 backfilled (prod: backfilled=113 then stalled).
      const EMPTY_A = "did:web:aaa-empty-a.example";
      const EMPTY_B = "did:web:bbb-empty-b.example";
      seedSpace(ctx.db as unknown as Database, EMPTY_A, USER, { allowPublicJoin: 1 });
      seedSpace(ctx.db as unknown as Database, EMPTY_B, USER, { allowPublicJoin: 1 });
      const { roomId } = await materializeSpace(ctx, SPACE, USER, {
        messageText: "the quick brown fox jumps",
      });
      // 249 more messages → 250 total. Batch ≤50 events per request
      // (MAX_BATCH_SIZE) to avoid the IP rate limiter.
      for (let batch = 0; batch < 5; batch++) {
        const events = [];
        for (let i = batch * 50; i < Math.min((batch + 1) * 50, 249); i++) {
          const messageId = newUlid();
          events.push({
            id: messageId,
            $type: "space.roomy.message.createMessage.v0",
            room: roomId,
            body: {
              mimeType: "text/plain",
              data: { $bytes: Buffer.from(`message number ${i}`).toString("base64") },
            },
            extensions: {},
          });
        }
        const res = await ctx.authedFetch(USER)(
          `${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`,
          {
            method: "POST",
            body: JSON.stringify({ spaceId: SPACE, events }),
          },
        );
        if (res.status !== 200) throw new Error(`sendMessage failed ${res.status}`);
      }
      await flushSearchQueue();

      const globalDb = (ctx.db as unknown as {
        global(): { query(sql: string): { get<T>(...p: unknown[]): Promise<T | null> } };
      }).global();
      _resetSearchBackfill();
      startSearchBackfill({ globalDb: globalDb as never });
      try {
        // 30 cycles: 2 empty spaces + 3 message-space visits ≈ 15 cycles, so
        // 30 is enough to prove rotation continues (no stall on an empty
        // space).
        for (let i = 0; i < 30; i++) {
          await sweepCycle(globalDb as never);
        }
      } finally {
        await stopSearchBackfill();
      }

      // All 250 messages must be backfilled — with the stale-updated_at bug
      // the sweeper stalls on an empty space after ~3 cycles and this fails.
      expect(searchBackfillStats().backfilled).toBe(250);
    },
    { timeout: 30000 },
  );
});
