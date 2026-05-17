/**
 * Canonical query-key construction.
 *
 * Both query factories (which read from the cache) and the
 * invalidation router (which writes to the cache) call this helper
 * so keys match exactly. Object identity of the returned array does
 * not matter to TanStack — what matters is that the *contents* are
 * structurally equal, which requires deterministic param ordering.
 *
 * The serialized form is always:
 *
 *     [nsid, { ...sortedParams }]
 *
 * Sorting param keys alphabetically removes any dependency on the
 * order a caller happened to spell their object literal in. The
 * helper is pure — calling it twice with equivalent inputs yields
 * structurally identical arrays.
 */

import type { QueryKey } from "./adapter";

/**
 * Construct a canonical {@link QueryKey} from an NSID and parameters.
 *
 * Returns a 1- or 2-element array. The single-element form (no
 * params) is emitted when `params` is omitted or empty, which makes
 * partial-prefix invalidation (e.g. "invalidate all queries for this
 * NSID") work naturally with TanStack's `queryKey` prefix matching.
 */
export function queryKey(
  nsid: string,
  params?: Record<string, unknown>,
): QueryKey {
  if (!params) return [nsid];

  const keys = Object.keys(params);
  if (keys.length === 0) return [nsid];

  keys.sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = params[k];

  return [nsid, sorted];
}
