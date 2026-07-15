/**
 * XRPC: space.roomy.getFlags (query).
 *
 * Returns the set of feature flag keys that are enabled for the calling user.
 * All flags default to false. A flag is enabled if the admin has set it
 * globally (all users) or assigned the caller's DID specifically.
 *
 * Authenticated: requires a valid user DID.
 */

import { openDb } from "../db/db.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { getEnabledFlagsForUser } from "../queries/featureFlags.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetFlagsResult {
  flags: string[];
}

export const getFlagsHandler: QueryHandler<
  QueryParams,
  GetFlagsResult
> = async (_params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const db = openDb();
  const flags = await getEnabledFlagsForUser(db, userDid);
  return { flags };
};
