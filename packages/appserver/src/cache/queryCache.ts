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
 * - **Coverage eviction.** Two NSIDs cannot use that rule, because their
 *   params are filters over a per-caller result rather than an identity:
 *   `getActivityFeed` (`evictActivityFeed`) and `getSpaces`
 *   (`evictSpaceList`). `{ spaceId, roomId }` is a subset of no entry's
 *   params, so subset matching would match nothing and leave stale entries;
 *   both match against what the cached body contains instead.
 */

import {
  queryCacheKey,
  normalizeParams,
  paramsSubset,
} from "./queryCacheKey.ts";
import { activityFeedCoverage } from "./activityFeedCoverage.ts";
import { spacesCoverSpace } from "./spaceListCoverage.ts";

export interface QueryCacheOptions {
  /** Max entries before LRU eviction. Default 4096. */
  maxEntries?: number;
  /** TTL in milliseconds (safety net). Default 60_000. */
  ttlMs?: number;
}

export interface QueryCacheNsidStats {
  hits: number;
  misses: number;
  evictions: number;
}

export interface QueryCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  /**
   * The same counters attributed to the NSID they belong to. The aggregate
   * numbers cannot distinguish "the cache is too small" from "one endpoint is
   * evicted on every write", which are fixed differently — this breakdown is
   * what makes that distinction observable.
   */
  byNsid: Record<string, QueryCacheNsidStats>;
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
  readonly #byNsid = new Map<string, QueryCacheNsidStats>();
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(opts: QueryCacheOptions = {}) {
    this.#maxEntries = opts.maxEntries ?? 4096;
    this.#ttlMs = opts.ttlMs ?? 60_000;
  }

  /** Increment one per-NSID counter, creating the row on first use. */
  #count(nsid: string, field: keyof QueryCacheNsidStats): void {
    const row = this.#byNsid.get(nsid) ?? { hits: 0, misses: 0, evictions: 0 };
    row[field]++;
    this.#byNsid.set(nsid, row);
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
      this.#count(nsid, "misses");
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.#store.delete(key);
      this.#misses++;
      this.#count(nsid, "misses");
      return undefined;
    }
    // LRU: move to end (most recent position).
    this.#store.delete(key);
    this.#store.set(key, entry);
    this.#hits++;
    this.#count(nsid, "hits");
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
        const evicted = this.#store.get(oldest);
        this.#store.delete(oldest);
        this.#evictions++;
        if (evicted) this.#count(evicted.nsid, "evictions");
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
      this.#count(nsid, "evictions");
    }
  }

  /**
   * Evict `space.getActivityFeed` entries by *feed coverage* rather than by
   * param subset.
   *
   * The feed's params carry a space as a filter (`{ spaceId: "X" }` = only X's
   * rooms) or nothing at all (`{}` = every joined space). Both describe the
   * same query family, so the subset rule in {@link evictMatching} cannot be
   * used: `{ spaceId: "X" }` is a subset of *no* entry's params, including the
   * global one it genuinely stales. See `activityFeedCoverage`.
   *
   * @param signalSpace the space the signal stales, or `null` for a signal
   *   that reaches every space (a caller-scoped one, e.g. joining a space).
   *   `null` evicts every page including the space-filtered ones, because a
   *   change to which spaces a caller belongs restates the whole feed.
   */
  evictActivityFeed(signalSpace: string | null, affectedUser?: string): void {
    for (const [key, entry] of this.#store) {
      if (entry.nsid !== "space.roomy.space.getActivityFeed") continue;
      // A page with no `spaceId` spans every space, so it holds this one's
      // rooms too and goes stale with it.
      const entrySpace = activityFeedCoverage(entry.params);
      if (signalSpace !== null && entrySpace !== null && entrySpace !== signalSpace) {
        continue;
      }
      if (affectedUser !== undefined) {
        if (entry.userDid !== affectedUser && entry.userDid !== "anon") continue;
      }
      this.#store.delete(key);
      this.#evictions++;
      this.#count(entry.nsid, "evictions");
    }
  }


  /**
   * Evict `space.getSpaces` entries whose cached body lists `signalSpace`.
   *
   * The list is per-caller and its params name no space, so — exactly as for
   * the activity feed above — a room-shaped change cannot be matched by param
   * subset: `{ spaceId, roomId }` is a subset of no entry's params, and the
   * callers who must drop their list are the ones whose list CONTAINS the
   * space. `spacesCoverSpace` reads that off the cached body.
   *
   * A caller with no row for the space is unaffected: nothing a room in that
   * space can do moves any number their list reports.
   */
  evictSpaceList(signalSpace: string, affectedUser?: string): void {
    for (const [key, entry] of this.#store) {
      if (entry.nsid !== "space.roomy.space.getSpaces") continue;
      if (!spacesCoverSpace(entry.value, signalSpace)) continue;
      if (affectedUser !== undefined) {
        if (entry.userDid !== affectedUser && entry.userDid !== "anon") continue;
      }
      this.#store.delete(key);
      this.#evictions++;
      this.#count(entry.nsid, "evictions");
    }
  }

  /** Evict a single entry by its exact key. Primarily for testing. */
  evict(key: string): void {
    const entry = this.#store.get(key);
    if (entry === undefined) return;
    this.#store.delete(key);
    this.#evictions++;
    this.#count(entry.nsid, "evictions");
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
      byNsid: Object.fromEntries(
        [...this.#byNsid].map(([nsid, s]) => [nsid, { ...s }]),
      ),
    };
  }
}