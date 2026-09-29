/**
 * Schema for `space.roomy.auth.setScopeSettings` (procedure, authenticated).
 * Source of truth: packages/appserver/src/handlers/space.roomy.auth.setScopeSettings.ts
 *
 * Lets the user *request* a change to the scope their OAuth grant covers.
 *
 * This endpoint cannot grant anything by itself — granting a wider scope
 * requires the PDS consent round-trip, which only the client can drive by
 * re-authorizing with the desired scope. So it records *intent*: the desired
 * raw scope string becomes a pending expansion the client can realise via
 * `requestScopeExpansion()`, and the stored last-granted scope (`user_oauth_grants`)
 * is updated only after `recordScopeGrant` runs with what `getTokenInfo()`
 * confirmed the PDS actually returned.
 *
 * A *narrowing* request (the desired scope is not a strict superset of the
 * stored grant — e.g. revoking Semble back to base) clears the pending
 * expansion; the client narrows the stored grant directly so the next login
 * requests less (the live token keeps its scopes until the next re-auth).
 */
import { type } from "arktype";

export const NSID = "space.roomy.auth.setScopeSettings" as const;

export const Input = type({
  /** The desired raw scope string (a full tier computed client-side). */
  scope: "string",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});
