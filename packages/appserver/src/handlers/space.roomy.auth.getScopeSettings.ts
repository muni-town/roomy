/**
 * XRPC: space.roomy.auth.getScopeSettings (query).
 *
 * AUTHENTICATED. Returns the calling user's stored OAuth scope settings — the
 * raw last-granted scope string (the same value `getLoginScope` returns at
 * login) plus any pending-expansion intent recorded by `setScopeSettings`.
 *
 * "Per grantable tier, whether the store covers it" is deliberately NOT
 * computed here: tier names (`semble`, `withDms`) are a client-side UX
 * abstraction the server must not know. The settings page derives coverage
 * per tier from the raw scope via the client's `hasScopeSet`, and renders the
 * raw string for display — see the scope-expansion plan's Open Question 1.
 */

import { openReadStateDb } from "../db/db.ts";
import { selectGrantedScope } from "../queries/userOauthGrants.ts";
import { selectRequestedScope } from "../queries/userScopeIntents.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export interface GetScopeSettingsResult {
  scope: string | null;
  requestedScope: string | null;
}

export const getScopeSettingsHandler: QueryHandler<
  QueryParams,
  GetScopeSettingsResult
> = async (_params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const db = openReadStateDb();
  const scope = await selectGrantedScope(db, userDid);
  const requestedScope = await selectRequestedScope(db, userDid);

  return { scope, requestedScope };
};
