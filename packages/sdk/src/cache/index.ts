/**
 * Framework-agnostic cache abstractions.
 *
 * This module deliberately does not import any specific cache
 * library — concrete implementations live in subpath entries
 * (e.g. `@roomy-space/sdk/browser/tanstack`).
 */

export type { CacheAdapter, CachePatcher, QueryKey } from "./adapter";
export { queryKey } from "./query-key";
