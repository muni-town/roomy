/**
 * Framework-agnostic cache adapter contract.
 *
 * The SDK's sync layer (invalidation router, diff applicators) drives
 * cache updates through this interface. Concrete implementations live
 * outside the core — see `@roomy-space/sdk/browser/tanstack` for the
 * TanStack Query implementation.
 *
 * Core MUST NOT import any specific cache library; this file is the
 * boundary.
 */

/**
 * A structured cache key. Convention: first element is the NSID
 * (or `#frame` tag), remaining elements are param scopes — see
 * `queryKey()` for the canonical construction.
 */
export type QueryKey = readonly unknown[];

/**
 * Patcher function passed to {@link CacheAdapter.patch}. Receives the
 * previous cached value (or `undefined` if the entry doesn't exist
 * yet — important for diff streams that race ahead of the initial
 * fetch) and returns the new value to store.
 */
export type CachePatcher<T> = (prev: T | undefined) => T;

/**
 * Minimal write surface a cache library must expose to the SDK.
 *
 * Implementations are expected to be synchronous in their effect on
 * subsequent reads from the same cache (TanStack `setQueryData` and
 * `invalidateQueries` both satisfy this — invalidation kicks off
 * refetches asynchronously, but the staleness flag flips immediately).
 */
export interface CacheAdapter {
  /**
   * Mark every cached entry whose key starts with `key` as stale,
   * triggering whatever refetch behaviour the underlying cache is
   * configured with.
   */
  invalidate(key: QueryKey): void;

  /**
   * Apply a structural update to a single cache entry. The patcher
   * receives the current value (or `undefined`) and returns the
   * replacement.
   */
  patch<T>(key: QueryKey, patcher: CachePatcher<T>): void;
}
