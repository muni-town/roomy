/**
 * XRPC: space.roomy.space.getSpaceSummary (query).
 *
 * Lightweight read of a space's display fields (name, avatar) only. This is
 * the badge-enrichment counterpart to `space.roomy.space.getMetadata`: it
 * skips the sidebar tree, active threads, read positions, and per-channel
 * access checks that make `getMetadata` expensive. A badge rendering an
 * internal link only needs an avatar + label, so this handler returns just
 * that — one SQL row, one ban check, no fan-out.
 *
 * Auth: anonymous callers may read public spaces (same gate as
 * `requireSpaceRead`). Banned callers get 403.
 */

import { spaceAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetSpaceSummaryResult {
  name?: string;
  avatar?: string;
}

export const getSpaceSummaryHandler: QueryHandler<
  QueryParams,
  GetSpaceSummaryResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = requireString(params, "spaceId");

  const db = openDb();

  // Ban check only — badges don't need membership/admin status, and public
  // spaces are readable anonymously. No hydrateUserMembership: the ban table
  // is space-scoped, not personal-stream-scoped, so it's populated by the
  // space's materializer and readable without hydration.
  const access = await spaceAccess(db, spaceId, userDid);
  if (access.isBanned) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }

  const row = await db
    .query(
      `select ci.name as name, ci.avatar as avatar
         from comp_space cs
         left join comp_info ci on ci.entity = cs.entity
        where cs.entity = ?`,
    )
    .get<{ name: string | null; avatar: string | null }>(spaceId);

  if (row === null) {
    throw new XrpcError(404, "NotFound", `Space not found: ${spaceId}`);
  }

  return stripNulls({
    name: row.name,
    avatar: row.avatar,
  }) as GetSpaceSummaryResult;
};