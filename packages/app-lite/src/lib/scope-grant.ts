/**
 * Pure, unit-testable decisions for client-side OAuth grant tracking.
 *
 * The reactive side lives in `auth.svelte.ts` (Svelte runes + `$env`/SDK
 * imports, not importable under app-lite's `node --test` runner). This module
 * holds the *decisions* that module applies, deliberately free of `$env`,
 * `$app`, and the SDK — mirroring how `scopes.ts` and `last-login.ts` keep
 * testable pure logic out of their reactive/`svelte.ts` wrappers.
 *
 * Three contracts are pinned here:
 *
 *   - **Login scope reconciliation.** `getLoginScope` (unauthenticated) may
 *     return the user's previously-stored scope, or `null` for a first-time /
 *     never-recorded user. `decideLoginScope` turns that into the exact scope
 *     to request: `null`/empty → the base tier (fresh or unrecorded user),
 *     otherwise the stored scope reconciled against the ceiling the *active*
 *     OAuth client declares.
 *
 *   - **Scope-expansion re-auth identity.** `decideScopeReauthIdentity` names
 *     the account an expansion re-authorizes as. The handle typed at login
 *     lives only in memory and is lost the instant the browser redirects to
 *     the PDS, so the session's DID — which survives the reload — is the
 *     authoritative source. This is a distinct decision (and test seam)
 *     because getting it wrong silently no-ops the consent round-trip.
 *
 *   - **App-password (test-mode) grants.** An app-password session has no
 *     OAuth token, so there is no `getTokenInfo()` to introspect and nothing
 *     to record. The app-password path is treated as fully granting the
 *     requested tier, so feature gates behave identically to OAuth. This is
 *     the single source the `auth.svelte.ts` `grantedScope` initializer uses.
 */

import { FULL_SCOPE_CEILING, SCOPE_SETS, reconcileScope } from "./scopes.ts";

/**
 * Decide the OAuth scope to request at login from the server's stored scope
 * (the raw grant from `getLoginScope`, or `null` when no grant exists).
 *
 *   - `null` / empty / whitespace → the base tier. This is both a first-time
 *     user and the "getLoginScope failed, fall back to base" path.
 *   - otherwise → `reconcileScope(stored, base, ceiling)` (base always
 *     retained, tokens outside `ceiling` dropped, deduped).
 *
 * `ceiling` MUST be the ceiling the *active OAuth client declares*, not
 * unconditionally the full metadata ceiling. The dev loopback client embeds
 * its scope in the client id, which is narrower than the deployed metadata
 * (`FULL_SCOPE_CEILING`) because it has to fit the browser's 4096-byte Referer
 * cap; reconciling against the full ceiling there re-requests tokens the
 * client does not declare, and the PDS rejects the whole authorization with
 * `invalid_scope`. See `activeClientCeiling` in `auth.svelte.ts`.
 */
export function decideLoginScope(
  stored: string | null | undefined,
  ceiling: string = FULL_SCOPE_CEILING,
): string {
  if (!stored || stored.trim() === "") return SCOPE_SETS.base;
  return reconcileScope(stored, SCOPE_SETS.base, ceiling);
}

/**
 * The identifier a scope-expansion round-trip re-authorizes as, or `null` when
 * there is none to drive one with.
 *
 * **Prefer the session's DID over the handle.** An expansion is a *fresh*
 * OAuth authorization: the browser navigates to the PDS and back, so the
 * callback runs in a brand-new document where the in-memory handle (the value
 * the user typed at `login()`) is gone. The session DID survives because the
 * session itself is persisted, and both OAuth clients accept a DID here (the
 * atproto client resolves it via `isAtprotoDid`; the HappyView client branches
 * on `isDid`). The handle is only a fallback for a caller that has one but no
 * session yet. `null` means a signed-out / sessionless caller (e.g. the
 * settings page reached while signed out): the caller records the intent for
 * the next login rather than driving a round-trip that cannot name an account.
 */
export function decideScopeReauthIdentity(input: {
  sessionDid?: string | null;
  handle?: string | null;
}): string | null {
  return input.sessionDid || input.handle || null;
}

/**
 * The `grantedScope` value the app-password (test-mode) path is treated as
 * holding. An app-password session has no OAuth token, so this is the requested
 * tier, not a token introspection result — and `recordScopeGrant` is never sent
 * (there is no PDS grant to record). Keeping it a named constant means the
 * reactive branch can never accidentally reach `session.getTokenInfo()`.
 */
export const APP_PASSWORD_GRANTED_SCOPE: string = SCOPE_SETS.base;
