/**
 * Schema for `space.roomy.auth.getScopeSettings` (query, authenticated).
 * Source of truth: packages/appserver/src/handlers/space.roomy.auth.getScopeSettings.ts
 *
 * Returns the calling user's stored OAuth scope settings — the raw
 * last-granted scope string (the same value `getLoginScope` returns at login)
 * plus any wider scope the user has *requested* but not yet had confirmed by
 * the PDS (a pending expansion intent recorded by `setScopeSettings`).
 *
 * "Per grantable tier, whether the store covers it" is deliberately NOT
 * computed here: tier names (`semble`, `withDms`) are a client-side UX
 * abstraction and the server must not know them. The client maps tier →
 * capability and derives coverage from the raw scope via `hasScopeSet`, and
 * renders the raw scope string for display. See the scope-expansion plan's
 * Open Question 1.
 */
import { type } from "arktype";

export const NSID = "space.roomy.auth.getScopeSettings" as const;

export const Params = type({});

export const Response = type({
  /**
   * The raw last-granted scope string from `getTokenInfo()`, or null when the
   * user has never recorded a grant.
   */
  "scope?": "string | null",
  /**
   * A wider scope the user requested via `setScopeSettings` but the PDS has
   * not yet confirmed (a strict superset of `scope`), or null when there is
   * no pending expansion. The client drives the PDS consent round-trip to
   * realise it; `recordScopeGrant` then records the confirmed grant.
   */
  "requestedScope?": "string | null",
});
