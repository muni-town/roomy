/**
 * Unit tests for the Qdrant client wrapper (src/search/qdrantSearch.ts),
 * using an in-memory fake client — no network.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  MESSAGES_COLLECTION,
  BM25_VECTOR_NAME,
  messagePointId,
  ensureMessagesCollection,
  upsertMessage,
  deleteMessage,
  searchMessages,
  countMessagesInSpace,
  _setQdrantClientForTest,
  _resetQdrantClient,
  _resetMessagesCollection,
  type QdrantClientLike,
} from "./qdrantSearch.ts";
import type { SparseVector } from "./bm25.ts";

interface FakePoint {
  id: string;
  vector: { [name: string]: SparseVector };
  payload: Record<string, unknown>;
}

/**
 * Minimal in-memory Qdrant: stores points, supports filtered sparse-vector
 * scoring (dot product), pagination, and collection existence.
 */
class FakeQdrant implements QdrantClientLike {
  exists = false;
  created = false;
  payloadIndexes: string[] = [];
  points: FakePoint[] = [];

  async collectionExists(name: string): Promise<{ exists: boolean }> {
    if (name !== MESSAGES_COLLECTION) return { exists: false };
    return { exists: this.exists };
  }

  async createCollection(name: string, _args: unknown): Promise<unknown> {
    if (name === MESSAGES_COLLECTION) {
      this.exists = true;
      this.created = true;
    }
    return {};
  }

  async createPayloadIndex(_name: string, _args: unknown): Promise<unknown> {
    return {};
  }

  async upsert(name: string, args: unknown): Promise<unknown> {
    if (name !== MESSAGES_COLLECTION) throw new Error("wrong collection");
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

  async delete(name: string, args: unknown): Promise<unknown> {
    if (name !== MESSAGES_COLLECTION) throw new Error("wrong collection");
    const { points } = args as { points: string[] };
    this.points = this.points.filter((p) => !points.includes(p.id));
    return {};
  }

  async query(
    name: string,
    args: unknown,
  ): Promise<{
    points: Array<{ id: unknown; score: number; payload?: Record<string, unknown> | null }>;
  }> {
    if (name !== MESSAGES_COLLECTION) throw new Error("wrong collection");
    const { query, using, filter, limit, offset = 0 } = args as {
      query: SparseVector;
      using: string;
      filter?: { must?: Array<{ key: string; match: { any?: string[]; value?: string } }> };
      limit: number;
      offset?: number;
    };
    if (using !== BM25_VECTOR_NAME) throw new Error("wrong vector name");

    const spaceDids = new Set<string>();
    const roomIds = new Set<string>();
    for (const cond of filter?.must ?? []) {
      if (cond.key === "spaceDid" && cond.match) {
        if (cond.match.any) for (const v of cond.match.any) spaceDids.add(v);
        if (cond.match.value) spaceDids.add(cond.match.value);
      }
      if (cond.key === "roomId" && cond.match?.any) {
        for (const v of cond.match.any) roomIds.add(v);
      }
    }

    const scored: Array<{ id: string; score: number; payload: Record<string, unknown> }> = [];
    for (const p of this.points) {
      if (spaceDids.size > 0 && !spaceDids.has(p.payload.spaceDid as string)) continue;
      if (roomIds.size > 0 && !roomIds.has(p.payload.roomId as string)) continue;
      const doc = p.vector[using];
      if (!doc) continue;
      // Dot product of shared indices (query and doc), like Qdrant sparse.
      const queryMap = new Map<number, number>();
      for (let i = 0; i < query.indices.length; i++) {
        queryMap.set(query.indices[i]!, query.values[i]!);
      }
      let score = 0;
      for (let i = 0; i < doc.indices.length; i++) {
        const qv = queryMap.get(doc.indices[i]!);
        if (qv !== undefined) score += qv * doc.values[i]!;
      }
      scored.push({ id: p.id, score, payload: p.payload });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const page = scored.slice(offset, offset + limit);
    return { points: page.map((p) => ({ id: p.id, score: p.score, payload: p.payload })) };
  }

  async count(name: string, args?: unknown): Promise<{ count: number }> {
    if (name !== MESSAGES_COLLECTION) throw new Error("wrong collection");
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

const SpaceRef = "did:web:space-a.example";

function vec(indices: number[], values: number[]): SparseVector {
  return { indices, values };
}

const FOX: SparseVector = { indices: [1, 2], values: [0.5, 0.5] };
const JUMP: SparseVector = { indices: [2, 3], values: [0.6, 0.4] };

beforeEach(() => {
  _resetQdrantClient();
  _resetMessagesCollection();
});

describe("messagePointId", () => {
  test("is a valid UUIDv5, deterministic per message id", () => {
    const a = messagePointId("01MSG");
    const b = messagePointId("01MSG");
    expect(a).toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(messagePointId("01MSG")).not.toBe(messagePointId("01MSH"));
  });
});

describe("ensureMessagesCollection", () => {
  test("creates the collection on first use with sparse bm25 + idf", async () => {
    const fake = new FakeQdrant();
    const created = await ensureMessagesCollection(fake);
    expect(created).toBe(true);
    expect(fake.exists).toBe(true);
  });

  test("does not recreate an existing collection", async () => {
    const fake = new FakeQdrant();
    fake.exists = true;
    const created = await ensureMessagesCollection(fake);
    expect(created).toBe(false);
  });
});

describe("upsertMessage / deleteMessage / countMessagesInSpace", () => {
  test("upsert is idempotent by point id", async () => {
    const fake = new FakeQdrant();
    fake.exists = true;
    _setQdrantClientForTest(fake);
    await upsertMessage(fake, "01MSG", FOX, {
      spaceDid: SpaceRef,
      roomId: "01ROOMA",
      threadId: null,
      authorDid: "did:plc:a",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await upsertMessage(fake, "01MSG", FOX, {
      spaceDid: SpaceRef,
      roomId: "01ROOMA",
      threadId: null,
      authorDid: "did:plc:a",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(fake.points).toHaveLength(1);
  });

  test("delete removes the point", async () => {
    const fake = new FakeQdrant();
    fake.exists = true;
    await upsertMessage(fake, "01MSG", FOX, {
      spaceDid: SpaceRef,
      roomId: "01ROOMA",
      threadId: null,
      authorDid: "did:plc:a",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await deleteMessage(fake, "01MSG");
    expect(fake.points).toHaveLength(0);
  });

  test("countMessagesInSpace counts per space", async () => {
    const fake = new FakeQdrant();
    fake.exists = true;
    for (const [id, space] of [
      ["01M1", SpaceRef],
      ["01M2", SpaceRef],
      ["01M3", "did:plc:other"],
    ] as const) {
      await upsertMessage(fake, id, FOX, {
        spaceDid: space,
        roomId: "01R",
        threadId: null,
        authorDid: "did:plc:a",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
    }
    expect(await countMessagesInSpace(fake, SpaceRef)).toBe(2);
  });
});

describe("searchMessages", () => {
  test("filters by space payload and ranks by sparse dot product", async () => {
    const fake = new FakeQdrant();
    fake.exists = true;
    await upsertMessage(fake, "01M1", FOX, {
      spaceDid: SpaceRef,
      roomId: "01RROOMA",
      threadId: null,
      authorDid: "did:plc:a",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await upsertMessage(fake, "01M2", JUMP, {
      spaceDid: SpaceRef,
      roomId: "01RROOMB",
      threadId: null,
      authorDid: "did:plc:b",
      timestamp: "2026-01-02T00:00:00.000Z",
    });
    await upsertMessage(fake, "01M3", JUMP, {
      spaceDid: "did:plc:other",
      roomId: "01RROOMC",
      threadId: null,
      authorDid: "did:plc:c",
      timestamp: "2026-01-03T00:00:00.000Z",
    });

    const hits = await searchMessages(fake, {
      sparse: FOX,
      spaceDids: [SpaceRef],
      limit: 10,
    });
    expect(hits.map((h) => h.messageId)).toEqual(["01M1", "01M2"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits.every((h) => h.payload.spaceDid === SpaceRef)).toBe(true);
  });

  test("empty space set returns no hits", async () => {
    const fake = new FakeQdrant();
    const hits = await searchMessages(fake, {
      sparse: FOX,
      spaceDids: [],
      limit: 10,
    });
    expect(hits).toEqual([]);
  });

  test("returns a window of ranked hits (pagination is sliced by the caller)", async () => {
    const fake = new FakeQdrant();
    fake.exists = true;
    for (let i = 0; i < 5; i++) {
      await upsertMessage(fake, `01M${i}`, FOX, {
        spaceDid: SpaceRef,
        roomId: "01RROOMX",
        threadId: null,
        authorDid: "did:plc:a",
        timestamp: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const hits = await searchMessages(fake, { sparse: FOX, spaceDids: [SpaceRef], limit: 3 });
    expect(hits).toHaveLength(3);
    // Distinct ids — a single window never repeats a point (offset-based
    // pagination can, on tied scores).
    expect(new Set(hits.map((h) => h.messageId)).size).toBe(3);
  });

  test("filters by roomIds payload when provided", async () => {
    const fake = new FakeQdrant();
    fake.exists = true;
    // Two rooms in the same space, one message each.
    await upsertMessage(fake, "01M1", FOX, {
      spaceDid: SpaceRef,
      roomId: "01RROOMA",
      threadId: null,
      authorDid: "did:plc:a",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await upsertMessage(fake, "01M2", FOX, {
      spaceDid: SpaceRef,
      roomId: "01RROOMB",
      threadId: null,
      authorDid: "did:plc:b",
      timestamp: "2026-01-02T00:00:00.000Z",
    });

    const hits = await searchMessages(fake, {
      sparse: FOX,
      spaceDids: [SpaceRef],
      roomIds: ["01RROOMA"],
      limit: 10,
    });
    expect(hits.map((h) => h.messageId)).toEqual(["01M1"]);
    expect(hits.every((h) => h.payload.roomId === "01RROOMA")).toBe(true);
  });
});
