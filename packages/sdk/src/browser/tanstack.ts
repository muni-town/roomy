/**
 * TanStack Query implementation of {@link CacheAdapter}.
 *
 * This lives under `browser/` because TanStack Query is a browser-
 * oriented dependency — server consumers (e.g. `appserver`) import
 * `@roomy-space/sdk` directly and never reach into `/browser`, so
 * `@tanstack/query-core` stays out of the server's dependency tree.
 *
 * Uses `@tanstack/query-core` rather than a framework-specific
 * package: the Svelte/React/Vue packages all build on the same
 * framework-agnostic `QueryClient`, so the adapter works regardless
 * of which UI framework the consumer chose.
 */

import type { QueryClient } from "@tanstack/query-core";
import type { CacheAdapter, CachePatcher, QueryKey } from "../cache/adapter";

/**
 * Wrap a TanStack {@link QueryClient} in the SDK's {@link CacheAdapter}
 * contract.
 *
 * Consumers construct the `QueryClient` themselves (so they retain
 * full control over default options, devtools wiring, etc.) and hand
 * it to the SDK only for cache writes from the sync layer.
 */
export function createTanstackCacheAdapter(
  queryClient: QueryClient,
): CacheAdapter {
  return {
    invalidate(key: QueryKey): void {
      // `invalidateQueries` returns a Promise that resolves when
      // every triggered refetch settles. The adapter contract is
      // fire-and-forget — we deliberately don't await it. Errors
      // surface through TanStack's per-query error state.
      void queryClient.invalidateQueries({ queryKey: key as unknown[] });
    },

    patch<T>(key: QueryKey, patcher: CachePatcher<T>): void {
      // `setQueryData` accepts an updater function whose return value
      // replaces the cached entry. Crucially, the updater is invoked
      // with `undefined` when no entry exists yet — the patcher
      // signature mirrors this so diff streams that race ahead of
      // the initial fetch can choose how to seed the cache.
      //
      // We coerce the QueryKey because TanStack types its key as
      // `readonly unknown[]` in some places and `unknown[]` in
      // others; the runtime accepts either.
      queryClient.setQueryData<T>(
        key as unknown[],
        (prev: T | undefined) => patcher(prev),
      );
    },
  };
}
