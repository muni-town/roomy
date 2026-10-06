/**
 * Whether the query cache is serving stale data.
 *
 * Every query in app-lite holds `staleTime: Infinity` and is refreshed by
 * WebSocket invalidation alone, so a failed refetch is the ordinary case, not
 * an exception: a slow or unreachable appserver leaves the query holding the
 * last value it was sent, with `status: "error"` alongside it. TanStack keeps
 * `state.data` through that transition (it reports the result as
 * `isRefetchError`), which is what lets a view go on showing the value it has.
 *
 * The state that counts is `status: "error"` **with** data: a failed
 * revalidation, where the view keeps its content and this count drives the
 * stale-data banner. An error **without** data is an empty view — there is
 * nothing to fall back on, so the view itself reports the failure.
 *
 * A recoverable session/auth failure is not treated differently: it is fixed by
 * the auto-reload recovery in `error-recovery.ts`, which reloads within a
 * second, and the value genuinely is stale until then.
 *
 * Kept free of TanStack and of Svelte so the rule is unit-testable on its own;
 * `query-health.svelte.ts` binds it to the live cache.
 */

/** The part of a query's state this rule reads. */
export interface QueryStateLike {
  status: string;
  data: unknown;
}

/** How many of `states` are showing a value whose last refresh failed. */
export function countStaleFailures(states: Iterable<QueryStateLike>): number {
  let count = 0;
  for (const state of states) {
    if (state.status === "error" && state.data !== undefined) count++;
  }
  return count;
}
