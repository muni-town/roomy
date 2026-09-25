/**
 * XRPC: space.roomy.space.getSpaces (query).
 *
 * Returns the caller's joined-and-not-removed spaces. Hydrates the caller's
 * membership, then queries local SQLite for the union of join intent
 * (`joinedSpace` edges from the user DID) and per-space membership truth.
 *
 * When `includeLeft=true`, also returns spaces the user has left
 * (with `isMember=false`).
 */

import { openReadStateDb } from "../db/db.ts";
import { selectJoinedSpaces, type SpaceRow } from "../queries/joinedSpaces.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetSpacesParams {
  includeLeft?: string;
}

interface GetSpacesResult {
  spaces: SpaceRow[];
}

export const getSpacesHandler: QueryHandler<
  QueryParams,
  GetSpacesResult
> = async (rawParams: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    // Anonymous users get an empty list for now.
    return { spaces: [] };
  }


  const params = rawParams as unknown as GetSpacesParams;
  const includeLeft = params.includeLeft === "true" || params.includeLeft === "1";

  const mainDb = openReadStateDb();
  return {
    spaces: await selectJoinedSpaces(mainDb, userDid, { includeLeft }),
  };
};
