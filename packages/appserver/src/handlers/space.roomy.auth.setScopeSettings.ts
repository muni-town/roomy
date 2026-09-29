/**
 * XRPC: space.roomy.auth.setScopeSettings (procedure).
 *
 * AUTHENTICATED. Lets the user *request* a change to the scope their OAuth
 * grant covers, by recording the desired raw scope string.
 *
 * This endpoint cannot grant anything by itself — granting a wider scope
 * requires the PDS consent round-trip, which only the client can drive by
 * re-authorizing with the desired scope. So:
 *
 *   - An **expansion** request (desired is a strict superset of the user's
 *     *effective* scope — the union of the stored grant and any prior pending
 *     intent) is recorded as a pending intent (`user_scope_intents`). The
 *     client drives `requestScopeExpansion()`, and `recordScopeGrant` writes
 *     the confirmed grant only after `getTokenInfo()` reports what the PDS
 *     actually returned.
 *   - A **narrowing / no-op** request (desired is a subset of or equal to the
 *     effective scope) clears any pending intent. Narrowing the stored grant
 *     is the client's job (via `recordScopeGrant`), because narrowing needs
 *     no consent — it just means next login requests less; the live token
 *     keeps its scopes until the next re-auth.
 *
 * The desired scope is validated to be a non-empty string of distinct tokens.
 */

import { openReadStateDb } from "../db/db.ts";
import { selectGrantedScope } from "../queries/userOauthGrants.ts";
import {
  clearRequestedScope,
  selectRequestedScope,
  upsertRequestedScope,
} from "../queries/userScopeIntents.ts";
import {
  isStrictScopeExpansion,
  scopeTokens,
} from "../xrpc/scopeExpansion.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface SetScopeSettingsBody {
  scope?: unknown;
}

/**
 * The union of a grant and a pending request — the full set of scopes the
 * user is currently known to want. Used to decide whether a new request is an
 * expansion relative to everything already in play, so a request that narrows
 * an earlier pending expansion still clears it instead of being misread as a
 * new expansion against the (possibly null) grant alone.
 */
function effectiveScope(granted: string | null, requested: string | null): string {
  const tokens = new Set<string>();
  for (const t of scopeTokens(granted ?? "")) tokens.add(t);
  for (const t of scopeTokens(requested ?? "")) tokens.add(t);
  return [...tokens].join(" ");
}

export const setScopeSettingsHandler: ProcedureHandler<
  SetScopeSettingsBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: SetScopeSettingsBody) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const desired = body.scope;
  if (typeof desired !== "string" || scopeTokens(desired).size === 0) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: scope",
    );
  }

  const db = openReadStateDb();
  const granted = await selectGrantedScope(db, userDid);
  const priorRequested = await selectRequestedScope(db, userDid);

  const effective = effectiveScope(granted, priorRequested);
  const desiredSet = scopeTokens(desired);
  const effectiveSet = scopeTokens(effective);

  // A real expansion: desired strictly adds beyond everything already in play
  // (grant + any prior pending intent). Record it as the pending intent.
  if (isStrictScopeExpansion(desired, effective)) {
    await upsertRequestedScope(db, userDid, desired);
    return;
  }

  // Equal to the effective scope: idempotent re-affirmation. Keep the pending
  // intent when there already is one; otherwise leave it empty (grant-only).
  if (desiredSet.size === effectiveSet.size) {
    if (priorRequested !== null) {
      await upsertRequestedScope(db, userDid, desired);
    } else {
      await clearRequestedScope(db, userDid);
    }
    return;
  }

  // Narrowing/revoke: desired loses tokens relative to what's in play. Clear
  // any pending expansion (narrowing the stored grant itself is the client's
  // job — it needs no consent and just means next login requests less).
  await clearRequestedScope(db, userDid);
};
