/**
 * Reactive binding for the stale-data rule.
 *
 * The count is recomputed from the whole cache on every update rather than
 * tracked incrementally, so it cannot drift from the cache it describes: a
 * query that refetches successfully stops counting, and one the cache collects
 * stops existing. No per-query bookkeeping and no failure list to expire.
 *
 * The subscription is installed once, at module load, and lives as long as the
 * page — the `QueryClient` here is the app's singleton.
 */

import { queryClient } from "./client";
import { countStaleFailures } from "./query-health";

let staleCount = $state(0);

function recompute(): void {
  staleCount = countStaleFailures(
    queryClient.getQueryCache().getAll().map((query) => query.state),
  );
}

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" || event.type === "removed") recompute();
});

export const queryHealth = {
  /** How many cached queries are showing a value whose last refresh failed. */
  get staleCount(): number {
    return staleCount;
  },
};
