/**
 * XRPC: space.roomy.push.getPushPreferences (query).
 *
 * Returns the caller's notification preferences: a user-wide default level
 * plus any per-space overrides. Authenticated via `parseUserDid`.
 */

import { openDb } from "../db/db.ts";
import { getPushPreferences } from "../queries/pushPreferences.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { Level } from "../push/level.ts";

interface GetPreferencesResult {
  default: Level;
  perSpace: Array<{ spaceId: string; level: Level }>;
}

export const getPreferencesHandler: QueryHandler<
  QueryParams,
  GetPreferencesResult
> = async (_params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const db = openDb();
  return await getPushPreferences(db, userDid);
};
