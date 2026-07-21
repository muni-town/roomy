/**
 * Cache eviction listener for the {@link InvalidationRouter}.
 *
 * Subscribes to invalidation events and evicts stale entries from the
 * {@link QueryCache}. The per-user-vs-broadcast distinction is the core
 * correctness property:
 *
 * - **Per-user signal** (`affectedUser` set): only that user's entry is
 *   evicted, plus the anon bucket defensively (anon `canRead`/`canWrite`
 *   can change under the same mutation paths).
 * - **Broadcast signal** (`affectedUser` unset): every caller's entry for
 *   the `(nsid, params)` is evicted.
 *
 * The eviction uses param-subset matching (`evictMatching`) so a signal
 * with `{ spaceId }` correctly evicts entries cached with optional params
 * like `{ spaceId, includeDeleted }` — the signal's params are a subset of
 * the entry's params.
 */

import type { InvalidationRouter } from "../invalidation/types.ts";
import type { QueryInvalidation } from "../invalidation/types.ts";
import type { QueryCache } from "./queryCache.ts";

/**
 * Attach a cache eviction listener to the invalidation router.
 *
 * @returns An unsubscribe function. Call it on appserver close to release the
 *   subscription and stop evicting.
 */
export function attachCacheEvictionListener(
  router: InvalidationRouter,
  cache: QueryCache,
): () => void {
  return router.subscribe((events) => {
    for (const e of events) {
      if (e.kind !== "queryInvalidation") continue;
      const { nsid, params, affectedUser } = e.signal as QueryInvalidation;
      cache.evictMatching(nsid, params, affectedUser);
    }
  });
}