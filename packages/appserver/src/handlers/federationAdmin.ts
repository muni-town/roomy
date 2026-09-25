/**
 * Shared admin gating for the space.roomy.federation.get* query handlers.
 *
 * All four read handlers (getRequests / getIncoming / getOutgoing /
 * getGrants) require an authenticated, admin-of-the-space caller and read
 * from the global federation registry. This collapses the duplicated
 * boilerplate (parseUserDid -> requireSpaceAccess -> isAdmin -> openGlobalDb)
 * into one helper so the handlers only express their per-query SQL + response
 * shape.
 */

import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryParams } from "../xrpc/types.ts";

export interface FederationAdminCtx {
  userDid: string;
  spaceId: string;
  spaceDb: ReturnType<typeof openSpaceDb>;
  /** Global federation registry DB. */
  db: ReturnType<typeof openGlobalDb>;
}

/**
 * Resolve the authenticated admin-of-space context for a federation query.
 * Throws XrpcError (401 / 403) when the caller is anonymous or not an admin.
 */
export async function requireFederationAdmin(
  params: QueryParams,
  auth: AuthCtx,
  viewLabel = "federation data",
): Promise<FederationAdminCtx> {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const spaceId = requireString(params, "spaceId");


  const spaceDb = openSpaceDb(spaceId);
  const access = await requireSpaceAccess(spaceDb, spaceId, userDid);
  if (!access.isAdmin) {
    throw new XrpcError(
      403,
      "Forbidden",
      `Only space admins can view ${viewLabel}`,
    );
  }

  return { userDid, spaceId, spaceDb, db: openGlobalDb() };
}

/**
 * Resolve a space's display name from its own per-space DB
 * (`comp_info.name`). Returns null when the space isn't materialised
 * locally (a space can be joined before its own stream materialises a
 * comp_info row), or when the counterpart's DB is on a stale schema without
 * `comp_info` (a blue-green rebuild serves the pre-rebuild file until it is
 * rebuilt) — a name lookup must never take down the whole federation list, so
 * callers fall back to the DID.
 */
export async function resolveSpaceName(spaceDid: string): Promise<string | null> {
  try {
    const info = await openSpaceDb(spaceDid)
      .query("select name from comp_info where entity = ?")
      .get<{ name: string | null }>([spaceDid]);
    return info?.name ?? null;
  } catch {
    return null;
  }
}
