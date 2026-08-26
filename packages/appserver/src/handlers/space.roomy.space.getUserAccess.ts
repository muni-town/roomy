/**
 * XRPC: space.roomy.space.getUserAccess (query).
 *
 * Reports a user's standing in a space: whether they are an admin and which
 * role IDs they hold. The arbiter's Rego policy engine calls this to make
 * access decisions, proxying the request as the stewarded space account.
 *
 * Authorisation: the caller MUST be the space itself — i.e. the request is
 * authenticated as the space's own DID. The router's prod auth verifier
 * validates the caller's JWT signature against the claimed issuer's
 * `#atproto` signing key, so `auth.did` is the space DID only when the token
 * was genuinely signed by the space's key (which the arbiter/PDS holds when
 * proxying under the stewarded account). An attacker cannot forge `iss` =
 * spaceDID without the space's signing key.
 *
 * This is the correct security boundary: the arbiter proxies policy-approved
 * requests under the stewarded space's account, so requiring the caller to
 * BE the space DID is what actually gates which policy can read a given
 * space's access state. Gating on the arbiter server's own DID would admit
 * every policy the arbiter runs, regardless of which space it is for.
 *
 * Fail-closed: an unknown / never-materialized space returns
 * `{ isAdmin: false, roleIds: [] }` rather than 404, so a policy engine
 * cannot distinguish "no data" from "no access".
 */

import { openSpaceDb } from "../db/db.ts";
import { isAdmin } from "../auth/access.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export interface GetUserAccessResult {
  isAdmin: boolean;
  roleIds: string[];
}

export const getUserAccessHandler: QueryHandler<
  QueryParams,
  GetUserAccessResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const spaceId = requireString(params, "spaceId");
  const userDid = requireString(params, "userDid");

  // Only the space's own account may read its own user-access state.
  if (auth.did === null || auth.did !== spaceId) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller must be the space's own DID",
    );
  }

  const db = openSpaceDb(spaceId);

  const [admin, roles] = await Promise.all([
    isAdmin(db, spaceId, userDid),
    db
      .query(
        `select role_id from member_roles
          where user_id = ? and stream_id = ?`,
      )
      .all<{ role_id: string }>(userDid, spaceId),
  ]);

  return {
    isAdmin: admin,
    roleIds: roles.map((r) => r.role_id),
  };
};
