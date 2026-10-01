/**
 * Server-side XRPC query response cache.
 *
 * Process-local, in-memory, LRU + TTL with invalidation-signal-driven
 * eviction. See `docs/plans/query-response-cache-plan.md` for the full
 * design.
 *
 * Cacheable set is explicit — only queries whose responses are fully covered
 * by `inferSignals` invalidation and that are expensive enough to warrant
 * caching are included. Procedures, sync, and cursor-paginated list queries
 * are never cached.
 */

import { QueryCache } from "./queryCache.ts";
import type { QueryNsid } from "../invalidation/types.ts";

export { QueryCache } from "./queryCache.ts";
export type {
  QueryCacheOptions,
  QueryCacheStats,
  QueryCacheNsidStats,
} from "./queryCache.ts";
export {
  queryCacheKey,
  canonicalParamsJson,
  normalizeParams,
  paramsSubset,
} from "./queryCacheKey.ts";
export { attachCacheEvictionListener } from "./evictListener.ts";

/**
 * NSIDs eligible for response caching. These three are:
 * - **Hot:** fetched by the sidebar, navigation, and every `SpaceRoomBadge`.
 * - **Expensive:** all run multiple access checks + read-position queries
 *   (`room.getMetadata` is the worst — 130+ SQL statements cold).
 * - **Fully covered by invalidation signals:** every field in their responses
 *   is invalidated by a modelled event or procedure emit (verified against
 *   `inferSignals.ts` and the procedure handlers post-`9579eea0`).
 */
export const CACHEABLE_NSIDS: ReadonlySet<QueryNsid> = new Set<QueryNsid>([
  "space.roomy.space.getMetadata",
  "space.roomy.room.getMetadata",
  "space.roomy.space.getSpaces",
  // The space index board and the activity feed.
  //
  // getThreads is keyed by `spaceId` and its signal names the same param, so
  // the ordinary subset rule evicts exactly the pages that went stale.
  //
  // getActivityFeed is not: it spans every space the CALLER joined and its
  // `spaceId` param is a filter, not an identity. Its signal names the space
  // that changed and is matched by feed coverage instead — see
  // `activityFeedCoverage.ts` for the table of param → coverage. Without that
  // rule the signal's space reads as "every page", which is what left the
  // cache unable to hold a hot page.
  "space.roomy.space.getThreads",
  "space.roomy.space.getActivityFeed",
]);

/**
 * Create a `QueryCache` with the production defaults, overridable by env vars.
 *
 * - `APPSERVER_QUERY_CACHE_ENABLED=false` → returns `undefined` (kill switch).
 * - `APPSERVER_QUERY_CACHE_MAX_ENTRIES` (default 4096).
 * - `APPSERVER_QUERY_CACHE_TTL_MS` (default 60000).
 */
export function createQueryCacheFromEnv(): QueryCache | undefined {
  const enabled = process.env.APPSERVER_QUERY_CACHE_ENABLED ?? "true";
  if (enabled === "false" || enabled === "0") return undefined;

  const maxEntries = Number(process.env.APPSERVER_QUERY_CACHE_MAX_ENTRIES ?? 4096);
  const ttlMs = Number(process.env.APPSERVER_QUERY_CACHE_TTL_MS ?? 60_000);
  return new QueryCache({
    maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 4096,
    ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 60_000,
  });
}