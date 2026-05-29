/**
 * XRPC: space.roomy.space.getMembers (query).
 *
 * Returns the members of a space with profile data, plus admins-without-
 * membership as `externalAdmins`. Caller must be a member or admin.
 *
 * Stage 1: profile fields (handle/name/avatar) may be null when the user
 * hasn't been hydrated yet; that's expected and not an error.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface MemberRow {
  did: string;
  handle?: string;
  name?: string;
  avatar?: string;
  isAdmin: boolean;
  roleIds: string[];
}

interface ExternalAdminRow {
  did: string;
  handle?: string;
  name?: string;
  avatar?: string;
}

interface GetMembersResult {
  members: MemberRow[];
  externalAdmins: ExternalAdminRow[];
}

export const getMembersHandler: QueryHandler<
  QueryParams,
  GetMembersResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }
  const spaceId = requireString(params, "spaceId");

  await hydrateUserMembership(userDid);

  const db = openDb();
  requireSpaceAccess(db, spaceId, userDid);

  // Members: edges where head=spaceId, tail=user, label='member'.
  const memberRows = db
    .query<
      {
        did: string;
        handle: string | null;
        name: string | null;
        avatar: string | null;
        is_admin: number;
      },
      [string]
    >(
      `select
           m.tail as did,
           cu.handle as handle,
           ci.name as name,
           ci.avatar as avatar,
           exists (
             select 1 from edges
              where head = m.head and tail = m.tail and label = 'admin'
           ) as is_admin
         from edges m
         left join comp_user cu on cu.did = m.tail
         left join comp_info ci on ci.entity = m.tail
        where m.head = ? and m.label = 'member'`,
    )
    .all(spaceId);

  // Role assignments per member, scoped to this space's stream.
  const roleStmt = db.query<{ role_id: string }, [string, string]>(
    `select role_id from member_roles
        where user_id = ? and stream_id = ?`,
  );

  const members: MemberRow[] = memberRows.map((r) =>
    stripNulls({
      did: r.did,
      handle: r.handle,
      name: r.name,
      avatar: r.avatar,
      isAdmin: !!r.is_admin,
      roleIds: roleStmt.all(r.did, spaceId).map((row) => row.role_id),
    }) as MemberRow,
  );

  // External admins: admin edge present, member edge absent.
  const externalAdminRows = db
    .query<
      {
        did: string;
        handle: string | null;
        name: string | null;
        avatar: string | null;
      },
      [string]
    >(
      `select
           a.tail as did,
           cu.handle as handle,
           ci.name as name,
           ci.avatar as avatar
         from edges a
         left join comp_user cu on cu.did = a.tail
         left join comp_info ci on ci.entity = a.tail
        where a.head = ?
          and a.label = 'admin'
          and not exists (
            select 1 from edges m
             where m.head = a.head and m.tail = a.tail and m.label = 'member'
          )`,
    )
    .all(spaceId);

  return {
    members,
    externalAdmins: externalAdminRows.map((r) =>
      stripNulls({
        did: r.did,
        handle: r.handle,
        name: r.name,
        avatar: r.avatar,
      }) as ExternalAdminRow,
    ),
  };
};
