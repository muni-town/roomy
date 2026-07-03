/**
 * XRPC: space.roomy.space.getInvites (query).
 *
 * Active invite tokens. Admins see all; non-admin members see only invites
 * they themselves created. If `allow_member_invites` is disabled and caller
 * is not admin, returns Forbidden (the response would be empty anyway, but
 * explicit denial makes intent clear per spec).
 */

import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface InviteRow {
  token: string;
  createdBy: string;
  eventUlid: string;
}

interface GetInvitesResult {
  invites: InviteRow[];
}

export const getInvitesHandler: QueryHandler<
  QueryParams,
  GetInvitesResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const spaceId = requireString(params, "spaceId");

  await hydrateUserMembership(userDid);

  const db = openDb();
  const access = await requireSpaceAccess(db, spaceId, userDid);

  if (!access.isAdmin) {
    const policy = await db
      .query("select allow_member_invites from comp_space where entity = ?")
      .get<{ allow_member_invites: number | null }>(spaceId);
    // null = unset; spec default is "false" — non-admins are blocked.
    if (policy?.allow_member_invites !== 1) {
      throw new XrpcError(
        403,
        "Forbidden",
        "Member-created invites are disabled in this space",
      );
    }
  }

  const rows = await (access.isAdmin
    ? db
        .query(
          `select token, created_by_did, event_ulid
               from comp_invite where entity = ?`,
        )
        .all<{ token: string; created_by_did: string; event_ulid: string }>(spaceId)
    : db
        .query(
          `select token, created_by_did, event_ulid
               from comp_invite
              where entity = ? and created_by_did = ?`,
        )
        .all<{ token: string; created_by_did: string; event_ulid: string }>(spaceId, userDid));

  return {
    invites: rows.map((r): InviteRow => ({
      token: r.token,
      createdBy: r.created_by_did,
      eventUlid: r.event_ulid,
    })),
  };
};
