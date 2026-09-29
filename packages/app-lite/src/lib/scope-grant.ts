/**
 * Pure, unit-testable decisions for client-side OAuth grant tracking.
 *
 * The reactive side lives in `auth.svelte.ts` (Svelte runes + `$env`/SDK
 * imports, not importable under app-lite's `node --test` runner). This module
 * holds the *decisions* that module applies, deliberately free of `$env`,
 * `$app`, and the SDK — mirroring how `scopes.ts` and `last-login.ts` keep
 * testable pure logic out of their reactive/`svelte.ts` wrappers.
 *
 * Two contracts are pinned here:
 *
 *   - **Login scope reconciliation.** `getLoginScope` (unauthenticated) may
 *     return the user's previously-stored scope, or `null` for a first-time /
 *     never-recorded user. `decideLoginScope` turns that into the exact scope
 *     to request: `null`/empty → the base tier (fresh or unrecorded user),
 *     otherwise the stored scope reconciled against the current ceiling.
 *
 *   - **App-password (test-mode) grants.** An app-password session has no
 *     OAuth token, so there is no `getTokenInfo()` to introspect and nothing
 *     to record. The app-password path is treated as fully granting the
 *     requested tier, so feature gates behave identically to OAuth. This is
 *     the single source the `auth.svelte.ts` `grantedScope` initializer uses.
 */

import { SCOPE_SETS, reconcileScope } from "./scopes.ts";

/**
 * Decide the OAuth scope to request at login from the server's stored scope
 * (the raw grant from `getLoginScope`, or `null` when no grant exists).
 *
 *   - `null` / empty / whitespace → the base tier. This is both a first-time
 *     user and the "getLoginScope failed, fall back to base" path.
 *   - otherwise → `reconcileScope(stored)` (base always retained, stale
 *     out-of-ceiling tokens dropped, deduped).
 */
export function decideLoginScope(
  stored: string | null | undefined,
): string {
  if (!stored || stored.trim() === "") return SCOPE_SETS.base;
  return reconcileScope(stored);
}

/**
 * The `grantedScope` value the app-password (test-mode) path is treated as
 * holding. An app-password session has no OAuth token, so this is the requested
 * tier, not a token introspection result — and `recordScopeGrant` is never sent
 * (there is no PDS grant to record). Keeping it a named constant means the
 * reactive branch can never accidentally reach `session.getTokenInfo()`.
 */
export const APP_PASSWORD_GRANTED_SCOPE: string = SCOPE_SETS.base;
