/**
 * XRPC: space.roomy.space.getSpaces (query).
 *
 * Returns the caller's joined-and-not-removed spaces. Hydrates the caller's
 * personal stream + each referenced space, then queries local SQLite for
 * the union of personal-stream intent and per-space membership truth.
 *
 * Stage 1 limitations:
 *   - unreadCount = 0 (no unread materialisation yet)
 *   - roleIds = [] (no roles materialisation yet)
 */

import { type, UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { selectJoinedSpaces, type SpaceRow } from "../queries/joinedSpaces.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetSpacesResult {
  spaces: SpaceRow[];
}

export const getSpacesHandler: QueryHandler<
  QueryParams,
  GetSpacesResult
> = async (_params: QueryParams, auth: AuthCtx) => {
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

  const db = openDb();
  return { spaces: selectJoinedSpaces(db, userDid, personalStreamDid) };
};
