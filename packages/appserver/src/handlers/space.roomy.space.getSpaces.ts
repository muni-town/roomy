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

import { type, UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectJoinedSpaces, type SpaceRow } from "../queries/joinedSpaces.ts";
import { XrpcError } from "../xrpc/errors.ts";
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
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }

  const { personalStreamDid } = await hydrateUserMembership(userDid);
  if (!personalStreamDid) {
    return { spaces: [] };
  }

  const params = rawParams as unknown as GetSpacesParams;
  const includeLeft = params.includeLeft === "true" || params.includeLeft === "1";

  const db = openDb();
  return {
    spaces: selectJoinedSpaces(db, userDid, personalStreamDid, { includeLeft }),
  };
};
