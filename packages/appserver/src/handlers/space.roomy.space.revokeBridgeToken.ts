/**
 * XRPC: space.roomy.space.revokeBridgeToken (procedure).
 *
 * Revokes the caller's bridge-token grant for a space. Grantor only — a
 * non-grantor gets 403 (this procedure is how the grantor frees their one
 * active grant, so anything else is an integrity violation). A spent grant
 * (bridged guild exceeded 100 members) is PERMANENT — it is locked to that
 * guild and cannot be revoked or moved elsewhere — 409. Otherwise the grant
 * row is deleted.
 */

import { openReadStateDb, openSpaceDb } from "../db/db.ts";
import {
  deleteGrant,
  selectGrantForGrantor,
} from "../queries/bridgeTokens.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface RevokeBridgeTokenBody {
  spaceId?: unknown;
}

interface RevokeBridgeTokenResult {
  revoked: boolean;
}

export const revokeBridgeTokenHandler: ProcedureHandler<
  RevokeBridgeTokenBody,
  RevokeBridgeTokenResult
> = async (_params: QueryParams, auth: AuthCtx, body: RevokeBridgeTokenBody) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
  if (spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }

  const spaceDb = openSpaceDb(spaceId);
  await requireSpaceAccess(spaceDb, spaceId, userDid);

  const readStateDb = openReadStateDb();
  const grant = await selectGrantForGrantor(readStateDb, userDid);

  // Grantor-only: the row must be the caller's own, for this space.
  if (!grant || grant.space_did !== spaceId) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller has no bridge-token grant for this space",
    );
  }

  if (grant.spent_at !== null) {
    throw new XrpcError(
      409,
      "AlreadySpent",
      "Already spent, cannot revoke",
    );
  }

  await deleteGrant(readStateDb, userDid);
  return { revoked: true };
};
