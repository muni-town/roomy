/**
 * Qdrant client wrapper for the global message index (Phase 2).
 *
 * Owns the process-wide `QdrantClient` (constructed from the config
 * singleton in `src/qdrant.ts`) and the `messages` collection schema:
 *
 * - One collection named `messages`, sparse BM25 vectors under the vector
 *   name `bm25` with the `idf` modifier (Qdrant applies collection IDF to
 *   sparse vectors at query time — see `src/search/bm25.ts`).
 * - Point id = UUIDv5(messageId) — Qdrant accepts UUID/uint64 ids only, and
 *   ULIDs are invalid.
 * - Payload: `{ spaceDid, roomId, threadId, authorDid, timestamp }` — NO
 *   message body (Qdrant returns IDs, SQLite hydrates the DTOs).
 *
 * All search operations are typed against a minimal structural interface so
 * unit/e2e tests can inject an in-memory fake (see the mocked-Qdrant e2e
 * test) without touching the real HTTP client.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";
import { getQdrant } from "../qdrant.ts";
import type { SparseVector } from "./bm25.ts";
import { log } from "../log.ts";

/** Collection name for the global message index. */
export const MESSAGES_COLLECTION = "messages";

/** Sparse vector name within a point. */
export const BM25_VECTOR_NAME = "bm25";

/** Qdrant DNS namespace for UUIDv5 point ids. */
const NS_NAMESPACE_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Structural slice of the QdrantClient that the search/index/backfill code
 * uses. The real `QdrantClient` satisfies it; tests inject a fake.
 */
export interface QdrantClientLike {
  collectionExists(collection_name: string): Promise<{ exists: boolean }>;
  createCollection(collection_name: string, args: unknown): Promise<unknown>;
  createPayloadIndex(collection_name: string, args: unknown): Promise<unknown>;
  upsert(collection_name: string, args: unknown): Promise<unknown>;
  delete(collection_name: string, args: unknown): Promise<unknown>;
  query(
    collection_name: string,
    args: unknown,
  ): Promise<{
    points: Array<{
      id: unknown;
      score: number;
      payload?: Record<string, unknown> | null;
    }>;
  }>;
  count(
    collection_name: string,
    args?: unknown,
  ): Promise<{ count: number }>;
}

/** Payload stored per message point — never the message body. */
export interface MessagePayload {
  spaceDid: string;
  roomId: string;
  /** The message's room when that room is a thread, else null. */
  threadId: string | null;
  authorDid: string;
  /** Canonical message timestamp as an ISO string. */
  timestamp: string;
}

/** A search hit returned by Qdrant. */
export interface QdrantHit {
  messageId: string;
  score: number;
  payload: MessagePayload;
}/**
 * Deterministic UUIDv5 (SHA-1, DNS namespace) for a message id. Same id
 * across processes and re-indexes, so upserts are idempotent.
 */
export function messagePointId(messageId: string): string {
  const ns = Buffer.from(NS_NAMESPACE_UUID.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(messageId, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Process-wide client ─────────────────────────────────────────────────

let clientInstance: QdrantClientLike | null | undefined;

/**
 * Get the process-wide Qdrant client, or `null` when Qdrant is not
 * configured (or was explicitly disabled via `_setQdrantClientForTest(null)`).
 * Constructs the real client lazily from the config singleton on first use.
 * A config that fails to construct (e.g. a malformed URL) is treated as
 * disabled: the constructor throw is caught, logged, and cached as null so
 * the request path 503s instead of 500ing on every call.
 */
export function getQdrantClient(): QdrantClientLike | null {
  if (clientInstance !== undefined) return clientInstance;
  const config = getQdrant();
  if (!config) {
    clientInstance = null;
    return null;
  }
  try {
    clientInstance = new QdrantClient({
      url: config.url,
      ...(config.port !== undefined ? { port: config.port } : {}),
      apiKey: config.apiKey,
    });
  } catch (err) {
    log.warn(`[qdrant] failed to construct client (${err instanceof Error ? err.message : String(err)}) — message search disabled`);
    clientInstance = null;
  }
  return clientInstance;
}

/**
 * Inject a fake client (tests). `null` disables Qdrant entirely.
 */
export function _setQdrantClientForTest(client: QdrantClientLike | null): void {
  clientInstance = client;
}

/** Forget the client (tests). The next getQdrantClient re-derives it. */
export function _resetQdrantClient(): void {
  clientInstance = undefined;
}

// ─── Collection ──────────────────────────────────────────────────────────

let collectionEnsured = false;

/**
 * Create the `messages` collection if it doesn't exist, plus payload
 * indexes on the filter fields. Idempotent; the result is memoised per
 * process (a single client per process). Returns `true` when the collection
 * was created — the backfill sweeper uses that to reset its cursors (a
 * fresh/wipe-recreated collection means every message must be re-indexed).
 */
export async function ensureMessagesCollection(
  client: QdrantClientLike,
): Promise<boolean> {
  if (collectionEnsured) return false;
  const existing = await client.collectionExists(MESSAGES_COLLECTION);
  if (!existing.exists) {
    await client.createCollection(MESSAGES_COLLECTION, {
      sparse_vectors: {
        [BM25_VECTOR_NAME]: { modifier: "idf" },
      },
    });
    // Best-effort payload indexes for the filter fields. A failure here
    // must not fail indexing (Qdrant filters without them — just slower).
    for (const field of ["spaceDid", "roomId", "timestamp"]) {
      try {
        await client.createPayloadIndex(MESSAGES_COLLECTION, {
          field_name: field,
          field_schema: "datetime",
        });
      } catch {
        // ignore — filtering still works without the index
      }
    }
    collectionEnsured = true;
    return true;
  }
  collectionEnsured = true;
  return false;
}

/** Forget the collection-ensured flag (tests). */
export function _resetMessagesCollection(): void {
  collectionEnsured = false;
}

// ─── Point operations ────────────────────────────────────────────────────

/** Upsert one indexed message. Idempotent (point id is deterministic). */
export async function upsertMessage(
  client: QdrantClientLike,
  messageId: string,
  sparse: SparseVector,
  payload: MessagePayload,
): Promise<void> {
  await client.upsert(MESSAGES_COLLECTION, {
    points: [
      {
        id: messagePointId(messageId),
        vector: { [BM25_VECTOR_NAME]: sparse },
        // The point id is UUIDv5(messageId) — a one-way hash — so the
        // original message id is carried in the payload for the hydration
        // step (Qdrant returns point ids, SQLite hydrates the DTOs).
        payload: { ...payload, messageId, threadId: payload.threadId ?? null },
      },
    ],
  });
}

/** Delete one message from the index. Idempotent. */
export async function deleteMessage(
  client: QdrantClientLike,
  messageId: string,
): Promise<void> {
  await client.delete(MESSAGES_COLLECTION, {
    points: [messagePointId(messageId)],
  });
}

// ─── Search ──────────────────────────────────────────────────────────────

export interface SearchMessagesOptions {
  /** BM25 sparse vector of the query. */
  sparse: SparseVector;
  /** Space DIDs the caller can read; results are restricted to these. */
  spaceDids: string[];
  /**
   * Window size to fetch. The handler over-fetches (limit×3) and slices by
   * cursor itself: Qdrant's sparse search returns points in an undefined
   * order among equal scores, so offset-based pagination can repeat points
   * (offset=1 may return the same point as offset=0). Fetching one window
   * from offset 0 and slicing in the appserver is deterministic.
   */
  limit: number;
}

/**
 * Run a sparse BM25 query over `messages`, payload-filtered to the given
 * spaces, ranked by score desc. Returns hits with their payloads (roomId +
 * spaceDid drive the read-access post-filter). Always fetches from offset 0
 * — see {@link SearchMessagesOptions.limit} for why pagination is sliced
 * by the caller.
 */
export async function searchMessages(
  client: QdrantClientLike,
  opts: SearchMessagesOptions,
): Promise<QdrantHit[]> {
  if (opts.spaceDids.length === 0) return [];

  const res = await client.query(MESSAGES_COLLECTION, {
    query: opts.sparse,
    using: BM25_VECTOR_NAME,
    filter: {
      must: [
        {
          key: "spaceDid",
          match: { any: [...opts.spaceDids] },
        },
      ],
    },
    limit: opts.limit,
    with_payload: true,
  });

  const hits: QdrantHit[] = [];
  for (const p of res.points) {
    const payload = p.payload;
    if (typeof p.id !== "string" || !payload) continue;
    // Sparse dot-product scores are > 0 exactly when the query shares a
    // term with the document; a 0 (or negative) score means no overlap.
    // Without this filter an unmatched query would return the whole
    // (limit-sized) corpus — Qdrant returns zero-score points by default.
    if (p.score <= 0) continue;
    const spaceDid = payload.spaceDid;
    const roomId = payload.roomId;
    const messageId = payload.messageId;
    if (
      typeof spaceDid !== "string" ||
      typeof roomId !== "string" ||
      typeof messageId !== "string"
    ) {
      continue;
    }
    hits.push({
      messageId,
      score: p.score,
      payload: {
        spaceDid,
        roomId,
        threadId: typeof payload.threadId === "string" ? payload.threadId : null,
        authorDid: typeof payload.authorDid === "string" ? payload.authorDid : "",
        timestamp: typeof payload.timestamp === "string" ? payload.timestamp : "",
      },
    });
  }
  return hits;
}

/** Count indexed messages in the given space (exact). */
export async function countMessagesInSpace(
  client: QdrantClientLike,
  spaceDid: string,
): Promise<number> {
  const res = await client.count(MESSAGES_COLLECTION, {
    filter: { must: [{ key: "spaceDid", match: { value: spaceDid } }] },
    exact: true,
  });
  return res.count;
}
