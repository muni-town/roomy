/**
 * Process-local in-memory response cache for XRPC queries.
 *
 * Keyed by `(nsid, params, userDid)`. Evicted by invalidation signals from
 * the {@link InvalidationRouter} (the correctness mechanism) with a TTL safety
 * net for unmodelled mutations.
 *
 * Design:
 * - **LRU** via `Map` insertion-order: on a hit, `delete` then `set` moves the
 *   entry to the newest position. On `set` when full, delete the oldest
 *   (`#store.keys().next().value`).
 * - **TTL is a safety net**, not the authority. Invalidation signals are the
 *   correctness mechanism. The TTL only guards against a missed signal (e.g.
 *   a future event type added without an `inferSignals` handler).
 * - **No negative caching.** Only successful (2xx) handler results are stored.
 *   The cache is never consulted for error responses — the router checks the
 *   cache before calling the handler, and only calls `set` after the handler
 *   returns successfully.
 * - **Subset eviction.** `evictMatching` uses param-subset semantics so a
 *   signal with `{ spaceId }` correctly evicts entries cached with
 *   `{ spaceId, includeDeleted }`. This is critical because invalidation
 *   signals omit optional params that request URLs may include.
 */

import {
  queryCacheKey,
  normalizeParams,
  paramsSubset,
} from "./queryCacheKey.ts";

export interface QueryCacheOptions {
  /** Max entries before LRU eviction. Default 4096. */
  maxEntries?: number;
  /** TTL in milliseconds (safety net). Default 60_000. */
  ttlMs?: number;
}

export interface QueryCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

interface CacheEntry {
  value: unknown;
  nsid: string;
  /** Normalized params, for subset matching during eviction. */
  params: Record<string, string>;
  userDid: string;
  expiresAt: number;
  insertedAt: number;
}

export class QueryCache {
  readonly #store = new Map<string, CacheEntry>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(opts: QueryCacheOptions = {}) {
    this.#maxEntries = opts.maxEntries ?? 4096;
    this.#ttlMs = opts.ttlMs ?? 60_000;
  }

  /**
   * Look up a cached response. Returns `undefined` on miss or TTL expiry
   * (expired entries are deleted lazily). On a hit, the entry is moved to the
   * newest position in the LRU order.
   */
  get(
    nsid: string,
    params: Record<string, unknown>,
    userDid: string | null,
  ): { value: unknown } | undefined {
    const key = queryCacheKey(nsid, params, userDid);
    const entry = this.#store.get(key);
    if (entry === undefined) {
      this.#misses++;
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.#store.delete(key);
      this.#misses++;
      return undefined;
    }
    // LRU: move to end (most recent position).
    this.#store.delete(key);
    this.#store.set(key, entry);
    this.#hits++;
    return { value: entry.value };
  }

  /**
   * Store a validated response. If the cache is at capacity, the oldest entry
   * is evicted first. An existing key is updated in place (preserving LRU
   * order by moving to newest).
   */
  set(
    nsid: string,
    params: Record<string, unknown>,
    userDid: string | null,
    value: unknown,
  ): void {
    const key = queryCacheKey(nsid, params, userDid);
    const normalized = normalizeParams(params);
    const did = userDid ?? "anon";
    const now = Date.now();

    if (this.#store.has(key)) {
      this.#store.delete(key);
    } else if (this.#store.size >= this.#maxEntries) {
      const oldest = this.#store.keys().next().value;
      if (oldest !== undefined) {
        this.#store.delete(oldest);
        this.#evictions++;
      }
    }

    const entry: CacheEntry = {
      value,
      nsid,
      params: normalized,
      userDid: did,
      expiresAt: now + this.#ttlMs,
      insertedAt: now,
    };
    this.#store.set(key, entry);
  }

  /**
   * Evict entries matching `(nsid, signalParams, affectedUser?)`.
   *
   * A signal matches an entry when:
   * - The NSID matches.
   * - `signalParams` is a subset of the entry's cached params (every key in
   *   `signalParams` has the same value in the entry's params). This ensures
   *   a signal with `{ spaceId }` evicts entries cached with optional params
   *   like `{ spaceId, includeDeleted }`.
   * - If `affectedUser` is set: the entry's `userDid` is `affectedUser` or
   *   `"anon"` (per-user fields also affect the anon bucket defensively).
   * - If `affectedUser` is unset (broadcast): all `userDid` values are evicted.
   */
  evictMatching(
    nsid: string,
    signalParams: Record<string, string>,
    affectedUser?: string,
  ): void {
    for (const [key, entry] of this.#store) {
      if (entry.nsid !== nsid) continue;
      if (!paramsSubset(signalParams, entry.params)) continue;
      if (affectedUser !== undefined) {
        if (entry.userDid !== affectedUser && entry.userDid !== "anon") {
          continue;
        }
      }
      this.#store.delete(key);
      this.#evictions++;
    }
  }

  /** Evict a single entry by its exact key. Primarily for testing. */
  evict(key: string): void {
    if (this.#store.delete(key)) {
      this.#evictions++;
    }
  }

  /** Clear all entries. Called on appserver close. */
  clear(): void {
    this.#store.clear();
  }

  get size(): number {
    return this.#store.size;
  }

  get stats(): QueryCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      size: this.#store.size,
    };
  }
}