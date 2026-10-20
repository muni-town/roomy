/**
 * A per-process read-through cache for the server's anonymous reads.
 *
 * It exists for the budget behind those reads, not for the latency: the
 * appserver limits each client IP to 100 XRPC requests per 60 s with a 120 s
 * block, counted *before* its own response cache, and a server-rendered origin
 * is one IP for every visitor. Without this, a document costs one request, so
 * a thousand visitors on one space exhaust the window; with it, the same URL
 * costs at most one request per TTL no matter how many documents rendered it,
 * and concurrent renders of one URL share a single in-flight request.
 *
 * Two behaviours it deliberately does not have:
 *
 * - **Failures are not held.** Only a value is cached; `null` is the reads'
 *   one failure shape (nonexistent space, invite-only space, rate limit,
 *   network failure), and holding it would keep a head degraded after the
 *   cause cleared. Concurrent failures still coalesce, because they share the
 *   in-flight promise.
 * - **It is not shared or persistent.** One instance per process, in memory:
 *   staleness is bounded by the TTL, and nothing here has to be invalidated
 *   across instances.
 *
 * Entries are evicted oldest-first once `maxEntries` is reached, so a crawler
 * walking arbitrary space DIDs cannot grow the map without bound.
 */

export interface ReadCacheOptions {
  /** How long a value is served before the read runs again. */
  ttlMs: number;
  /** Entries held before the oldest is dropped. */
  maxEntries: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface ReadCache {
  /**
   * `read`'s value for `key`, from the cache when fresh, otherwise from a
   * single call to `read` that every concurrent caller of `key` shares.
   *
   * The key must identify the response completely — the caller passes the
   * request URL — so one key always produces one value type.
   */
  readThrough<T>(key: string, read: () => Promise<T | null>): Promise<T | null>;
}

export function createReadCache(options: ReadCacheOptions): ReadCache {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { expires: number; value: unknown }>();
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    readThrough<T>(key: string, read: () => Promise<T | null>) {
      const cached = entries.get(key);
      if (cached && cached.expires > now()) {
        // Re-insert so the map's order stays least-recently-used first.
        entries.delete(key);
        entries.set(key, cached);
        return Promise.resolve(cached.value as T);
      }
      if (cached) entries.delete(key);

      const pending = inFlight.get(key) as Promise<T | null> | undefined;
      if (pending) return pending;

      const started = (async () => {
        try {
          const value = await read();
          if (value !== null && value !== undefined) {
            entries.set(key, { expires: now() + options.ttlMs, value });
            while (entries.size > options.maxEntries) {
              const oldest = entries.keys().next().value;
              if (oldest === undefined) break;
              entries.delete(oldest);
            }
          }
          return value;
        } finally {
          inFlight.delete(key);
        }
      })();

      inFlight.set(key, started);
      return started;
    },
  };
}
