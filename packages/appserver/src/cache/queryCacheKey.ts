/**
 * Canonical cache-key construction for the XRPC query response cache.
 *
 * The key is structurally identical to the client-side `queryKey()` helper
 * in `packages/sdk/src/cache/query-key.ts` (`[nsid, { ...sortedParams }]`),
 * serialized to a string so it can index a flat `Map`. Keeping server and
 * client canonicalisation aligned means a future shared invalidation log
 * could address both caches with the same param identity.
 *
 * The caller DID is part of the key because `getMetadata` / `getSpaces`
 * responses diverge per user (access decisions, unread counts,
 * `activeThreads`). Anonymous callers share a single `"anon"` bucket.
 */

/**
 * Serialize params to a canonical JSON string with alphabetically sorted keys.
 * Pure — calling twice with equivalent inputs yields identical output.
 */
export function canonicalParamsJson(
  params: Record<string, unknown>,
): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return "{}";
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = params[k];
  return JSON.stringify(sorted);
}

/**
 * Build a cache key string from `(nsid, params, userDid)`.
 *
 * `userDid` null → `"anon"`. There is no overload that omits `userDid` —
 * this is intentional to prevent accidental per-user leaks (a key constructed
 * without a `userDid` would be shared across callers).
 */
export function queryCacheKey(
  nsid: string,
  params: Record<string, unknown>,
  userDid: string | null,
): string {
  return `${nsid}:${canonicalParamsJson(params)}:${userDid ?? "anon"}`;
}

/**
 * Normalize `QueryParams` (`string | string[] | undefined` values) to a flat
 * `Record<string, string>` for storage and subset matching against invalidation
 * signals (which always use `Record<string, string>`).
 *
 * - `undefined` values are dropped (absent params).
 * - Array values take the first element (none of the cacheable queries use
 *   array params, but this keeps the function total).
 */
export function normalizeParams(
  params: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") {
      result[k] = v;
    } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      result[k] = v[0] as string;
    }
  }
  return result;
}

/**
 * Check whether `signal` is a subset of `entry`: every key in `signal` must
 * exist in `entry` with the same value. Used by `evictMatching` so that a
 * signal with `{ spaceId }` correctly evicts an entry cached with
 * `{ spaceId, includeDeleted }` — the signal's params are a subset of the
 * entry's params.
 */
export function paramsSubset(
  signal: Record<string, string>,
  entry: Record<string, string>,
): boolean {
  for (const [k, v] of Object.entries(signal)) {
    if (entry[k] !== v) return false;
  }
  return true;
}