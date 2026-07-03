/**
 * XRPC: space.roomy.space.getMembers (query).
 *
 * Returns the members of a space with profile data, plus admins-without-
 * membership as `externalAdmins`. Caller must be a member or admin.
 *
 * An optional `search` param filters both lists by a case-insensitive
 * substring match against handle, name, or DID — used by the chat-input
 * mention typeahead. The SQL lives in `queries/members.ts` so it can be
 * tested without the handler's auth/singleton-DB wiring.
 *
 * Stage 1: profile fields (handle/name/avatar) may be null when the user
 * hasn't been hydrated yet; that's expected and not an error.
 */

import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { optionalString, requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import {
  selectMembers,
  type SelectMembersResult,
} from "../queries/members.ts";

export type GetMembersResult = SelectMembersResult;

export const getMembersHandler: QueryHandler<
  QueryParams,
  GetMembersResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const spaceId = requireString(params, "spaceId");
  const search = optionalString(params, "search");

  await hydrateUserMembership(userDid);

  const db = openDb();
  await requireSpaceAccess(db, spaceId, userDid);

  return await selectMembers(db, spaceId, search);
};