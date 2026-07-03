/**
 * XRPC: space.roomy.space.getSpaces (query).
 *
 * Returns the caller's joined-and-not-removed spaces. Hydrates the caller's
 * personal stream + each referenced space, then queries local SQLite for
 * the union of personal-stream intent and per-space membership truth.
 *
 * When `includeLeft=true`, also returns spaces the user has previously left
 * (with `isMember=false`).
 */

import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
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

  const { personalStreamDid } = await hydrateUserMembership(userDid);
  if (!personalStreamDid) {
    return { spaces: [] };
  }

  const params = rawParams as unknown as GetSpacesParams;
  const includeLeft = params.includeLeft === "true" || params.includeLeft === "1";

  const db = openDb();
  return {
    spaces: await selectJoinedSpaces(db, userDid, personalStreamDid, { includeLeft }),
  };
};
