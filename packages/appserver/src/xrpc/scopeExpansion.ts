/**
 * Pure scope-string helpers for the appserver's auth handlers.
 *
 * The appserver stores raw scope strings (never tier names — tiers are a
 * client-side UX abstraction). These helpers do the only set semantics the
 * server needs for scope settings: comparing two raw scope strings for strict
 * expansion, without importing app-lite's `scopes.ts` (which pulls in Vite
 * env plumbing the Bun runtime shouldn't depend on).
 *
 * Kept dependency-free so it runs under `bun test` directly.
 */

/** Split a scope string into its individual tokens, dropping empties. */
export function scopeTokens(scope: string): Set<string> {
  return new Set(scope.split(" ").filter(Boolean));
}

/**
 * True when `desired` is a strict superset of `granted` — i.e. the user asked
 * to add scope beyond what the PDS has already granted (a real expansion).
 * A `null` granted scope (never recorded) counts as the empty set, so any
 * non-empty desired scope is an expansion. Equal sets and proper subsets are
 * false (revoke / no-op).
 */
export function isStrictScopeExpansion(
  desired: string | null,
  granted: string | null,
): boolean {
  const desiredSet = scopeTokens(desired ?? "");
  const grantedSet = scopeTokens(granted ?? "");
  if (desiredSet.size === 0) return false;
  for (const token of grantedSet) {
    if (!desiredSet.has(token)) return false;
  }
  return desiredSet.size > grantedSet.size;
}
