/**
 * In-memory Qdrant stand-in for the E2E stack's message search.
 *
 * The stack is hermetic: `launch-stack.ts` installs this client through
 * `_setQdrantClientForTest` before `createAppserver`, so the search indexer,
 * the backfill sweeper and `space.roomy.search.messages` all run against an
 * in-process index instead of a search service. Without it the endpoint
 * answers 503 (no `QDRANT_URL`) and message search cannot be covered.
 *
 * The behaviour mirrors the fake the appserver's own e2e suite uses
 * (`packages/appserver/src/e2e/search.test.ts`): sparse dot-product scoring
 * over the `bm25` vector, a payload filter on `spaceDid`/`roomId`, and
 * idempotent upserts keyed by point id. It is copied rather than imported so
 * that the app-lite suite does not depend on another package's test files.
 */

import type { QdrantClientLike } from "../../appserver/src/search/qdrantSearch.ts";
import type { SparseVector } from "../../appserver/src/search/bm25.ts";

/**
 * Argument shapes the search module passes to a Qdrant client. They mirror
 * `qdrantSearch.ts`, which is the fake's only caller.
 */
interface UpsertArgs {
  points: Array<{
    id: string;
    vector: Record<string, SparseVector>;
    payload: Record<string, unknown>;
  }>;
}

interface DeleteArgs {
  points: string[];
}

interface FilterCondition {
  key: string;
  match: { any?: string[]; value?: string };
}

interface QueryArgs {
  query: SparseVector;
  using: string;
  filter?: { must?: FilterCondition[] };
  limit: number;
  offset?: number;
}

interface CountArgs {
  filter?: { must?: FilterCondition[] };
}

interface FakePoint {
  id: string;
  vector: { [name: string]: SparseVector };
  payload: Record<string, unknown>;
}

/** Minimal Qdrant: filtered sparse scoring, pagination, collection management. */
export class FakeQdrant implements QdrantClientLike {
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
    const { points } = args as UpsertArgs;
    for (const p of points) {
      const idx = this.points.findIndex((q) => q.id === p.id);
      const point = { id: p.id, vector: p.vector, payload: p.payload };
      if (idx >= 0) this.points[idx] = point;
      else this.points.push(point);
    }
    return {};
  }

  async delete(_name: string, args: unknown): Promise<unknown> {
    const { points } = args as DeleteArgs;
    this.points = this.points.filter((p) => !points.includes(p.id));
    return {};
  }

  async query(
    _name: string,
    args: unknown,
  ): Promise<{
    points: Array<{
      id: unknown;
      score: number;
      payload?: Record<string, unknown> | null;
    }>;
  }> {
    const { query, using, filter, limit, offset = 0 } = args as QueryArgs;
    if (using !== "bm25") throw new Error("wrong vector name");

    const spaceDids = new Set<string>();
    const roomIds = new Set<string>();
    for (const cond of filter?.must ?? []) {
      if (cond.key === "spaceDid" && cond.match.any) {
        for (const v of cond.match.any) spaceDids.add(v);
      }
      if (cond.key === "roomId" && cond.match.any) {
        for (const v of cond.match.any) roomIds.add(v);
      }
    }

    const scored: Array<{
      id: string;
      score: number;
      payload: Record<string, unknown>;
    }> = [];
    const qm = new Map<number, number>();
    for (let i = 0; i < query.indices.length; i++) {
      qm.set(query.indices[i]!, query.values[i]!);
    }
    for (const p of this.points) {
      const spaceDid = p.payload.spaceDid;
      const roomId = p.payload.roomId;
      if (spaceDids.size > 0 && !(typeof spaceDid === "string" && spaceDids.has(spaceDid))) {
        continue;
      }
      if (roomIds.size > 0 && !(typeof roomId === "string" && roomIds.has(roomId))) {
        continue;
      }
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
    return {
      points: page.map((p) => ({ id: p.id, score: p.score, payload: p.payload })),
    };
  }

  async count(_name: string, args?: unknown): Promise<{ count: number }> {
    const { filter } = (args ?? {}) as CountArgs;
    let count = this.points.length;
    for (const cond of filter?.must ?? []) {
      if (cond.key === "spaceDid" && cond.match.value) {
        const value = cond.match.value;
        count = this.points.filter((p) => p.payload.spaceDid === value).length;
      }
    }
    return { count };
  }
}
