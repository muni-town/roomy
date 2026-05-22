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
import { getSpaceUnreadCount } from "../queries/readPositions.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface SpaceRow {
  id: string;
  name?: string;
  avatar?: string;
  description?: string;
  unreadCount: number;
  isMember: boolean;
  isAdmin: boolean;
  roleIds: string[];
}

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
  const rows = db
    .query<
      {
        id: string;
        name: string | null;
        avatar: string | null;
        description: string | null;
        is_member: number;
        is_admin: number;
      },
      [string, string]
    >(
      // Intent (personal-stream comp_space rows where hidden=0) joined with
      // each space's actual edge state. Excludes banned users and the
      // personal stream's own entity row.
      `select
           cs.entity as id,
           ci.name as name,
           ci.avatar as avatar,
           ci.description as description,
           exists (
             select 1 from edges
              where head = cs.entity and tail = ?1 and label = 'member'
           ) as is_member,
           exists (
             select 1 from edges
              where head = cs.entity and tail = ?1 and label = 'admin'
           ) as is_admin
         from entities e
         join comp_space cs on cs.entity = e.id
         left join comp_info ci on ci.entity = cs.entity
        where e.stream_id = ?2
          and e.id != ?2
          and cs.hidden = 0
          and not exists (
            select 1 from comp_bans
             where entity = cs.entity and user_did = ?1
          )
          and (
            exists (
              select 1 from edges
               where head = cs.entity and tail = ?1 and label = 'member'
            )
            or exists (
              select 1 from edges
               where head = cs.entity and tail = ?1 and label = 'admin'
            )
          )`,
    )
    .all(userDid, personalStreamDid);

  const spaces: SpaceRow[] = rows.map((r) => {
    const space: SpaceRow = {
      id: r.id,
      unreadCount: getSpaceUnreadCount(db, userDid, r.id),
      isMember: !!r.is_member,
      isAdmin: !!r.is_admin,
      roleIds: [],
    };
    // Omit optional string fields when null — AT Protocol lexicon
    // validation rejects null for non-nullable string properties.
    if (r.name !== null) space.name = r.name;
    if (r.avatar !== null) space.avatar = r.avatar;
    if (r.description !== null) space.description = r.description;
    return space;
  });

  return { spaces };
};
