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
 *
 * Two NSIDs are per-caller queries whose params are filters, not identities:
 * `getActivityFeed` and `getSpaces`. Their signals name the space (and, for
 * the list, the room) that changed, which is a subset of no entry's params —
 * subset matching would evict nothing and serve stale bodies. Each is routed
 * to a method that matches the signal against what the cached body CONTAINS.
 */

import type { InvalidationRouter } from "../invalidation/types.ts";
import type { QueryInvalidation } from "../invalidation/types.ts";
import type { QueryCache } from "./queryCache.ts";
import { activityFeedCoverage } from "./activityFeedCoverage.ts";

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
      if (nsid === "space.roomy.space.getActivityFeed") {
        cache.evictActivityFeed(activityFeedCoverage(params), affectedUser);
        continue;
      }
      if (nsid === "space.roomy.space.getSpaces") {
        // A room-shaped signal names the space whose list to check; a
        // caller-scoped one names no space at all, which reaches every list.
        const spaceId = params["spaceId"];
        if (spaceId !== undefined && spaceId !== "") {
          cache.evictSpaceList(spaceId, affectedUser);
          continue;
        }
      }
      cache.evictMatching(nsid, params, affectedUser);
    }
  });
}