/**
 * Members query for `space.roomy.space.getMembers`.
 *
 * `selectMembers` is the SQL behind that XRPC query: it returns space members
 * (with profile data, admin flag, and role ids) plus external admins (admin
 * edge present, member edge absent). Admin-ness is orthogonal to membership —
 * see `docs/livequery-inventory.md` (#18, #21).
 *
 * When `search` is provided, both lists are filtered by a case-insensitive
 * substring match against handle, name, or DID. This is what the chat-input
 * mention typeahead hits as the user types `@` + a prefix.
 *
 * Stage 1 note: profile fields (handle/name/avatar) may be null when a user
 * hasn't been hydrated yet; that's expected and not an error. `stripNulls`
 * drops nulls so the wire shape matches the lexicon (absent-or-present).
 */

import type { DbLike } from "../db/types.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";

export interface MemberRow {
  did: string;
  handle?: string;
  name?: string;
  avatar?: string;
  isAdmin: boolean;
  roleIds: string[];
}

export interface ExternalAdminRow {
  did: string;
  handle?: string;
  name?: string;
  avatar?: string;
}

export interface SelectMembersResult {
  members: MemberRow[];
  externalAdmins: ExternalAdminRow[];
}

/**
 * Build the `(cu.handle | ci.name | tail) LIKE ?` clause + bindings used to
 * filter by `search`. Returns `{ clause, binds }` where `binds` is meant to be
 * appended after the query's own positional params.
 */
function searchFilter(
  search: string | undefined,
  tailColumn: string,
): { clause: string; binds: string[] } {
  const q = search?.trim().toLowerCase();
  if (!q) return { clause: "", binds: [] };
  const pattern = `%${q}%`;
  return {
    clause:
      ` and (ifnull(cu.handle, '') like ?` +
      ` or ifnull(ci.name, '') like ?` +
      ` or ${tailColumn} like ?)`,
    binds: [pattern, pattern, pattern],
  };
}

/**
 * Return the members + external admins of a space, optionally filtered by
 * `search`. Caller is responsible for access control (the handler checks
 * `requireSpaceAccess` before calling this).
 */
export async function selectMembers(
  db: DbLike,
  spaceId: string,
  search?: string,
): Promise<SelectMembersResult> {
  const memberFilter = searchFilter(search, "m.tail");
  const memberRows = await db
    .query(
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
        where m.head = ? and m.label = 'member'${memberFilter.clause}`,
    )
    .all<{ did: string; handle: string | null; name: string | null; avatar: string | null; is_admin: number }>([spaceId, ...memberFilter.binds]);

  // Role assignments per member, scoped to this space's stream.
  const roleStmt = await db.query(
    `select role_id from member_roles
        where user_id = ? and stream_id = ?`,
  );

  const members: MemberRow[] = await Promise.all(memberRows.map(async (r) =>
    stripNulls({
      did: r.did,
      handle: r.handle,
      name: r.name,
      avatar: r.avatar,
      isAdmin: !!r.is_admin,
      roleIds: (await roleStmt.all<{ role_id: string }>([r.did, spaceId])).map((row) => row.role_id),
    }) as MemberRow,
  ));

  const extFilter = searchFilter(search, "a.tail");
  const externalAdminRows = await db
    .query(
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
          )${extFilter.clause}`,
    )
    .all<{ did: string; handle: string | null; name: string | null; avatar: string | null }>([spaceId, ...extFilter.binds]);

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
}