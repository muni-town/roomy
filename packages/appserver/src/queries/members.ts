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
 * The search filter is applied **in JS after** profiles are hydrated from the
 * global store, NOT in SQL. A member's profile entity lives in their own
 * stream, not this space's stream, so the per-space `comp_user`/`comp_info`
 * joins are null for cross-stream members (and are not written by the
 * materialiser at all in Phase 3). Filtering in SQL against those columns
 * would silently drop every member whose handle/name only exists in the
 * global `profiles` table — the exact failure the mention typeahead hit
 * (typing a handle or display name returned no results). The global store is
 * authoritative; the per-space value (if any) acts as a fallback.
 *
 * Stage 1 note: profile fields (handle/name/avatar) may be null when a user
 * hasn't been hydrated yet; that's expected and not an error. `stripNulls`
 * drops nulls so the wire shape matches the lexicon (absent-or-present).
 */

import type { DbLike } from "../db/types.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import { hydrateProfiles } from "./profileStore.ts";

export interface MemberRow {
  did: string;
  handle?: string;
  name?: string;
  avatar?: string;
  isAdmin: boolean;
  isBanned: boolean;
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
 * Case-insensitive substring match against handle, name, or DID. Used to
 * filter the hydrated member/admin lists for the mention typeahead. Returns
 * `true` for every item when `search` is empty/whitespace (no filter).
 */
export function memberMatchesSearch(
  m: { did: string; handle?: string; name?: string },
  search: string | undefined,
): boolean {
  const q = search?.trim().toLowerCase();
  if (!q) return true;
  return (
    (m.handle ?? "").toLowerCase().includes(q) ||
    (m.name ?? "").toLowerCase().includes(q) ||
    m.did.toLowerCase().includes(q)
  );
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
  // Fetch ALL members (no SQL search filter — see module docstring). The
  // per-space comp_user/comp_info joins are null for cross-stream members, so
  // filtering in SQL would miss them; we filter in JS after hydration.
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
           ) as is_admin,
           exists (
             select 1 from comp_bans
              where entity = m.head and user_did = m.tail
           ) as is_banned
         from edges m
         left join comp_user cu on cu.did = m.tail
         left join comp_info ci on ci.entity = m.tail
        where m.head = ? and m.label = 'member'`,
    )
    .all<{ did: string; handle: string | null; name: string | null; avatar: string | null; is_admin: number; is_banned: number }>([spaceId]);

  // Role assignments per member, scoped to this space's stream. Fetched in
  // ONE batched query (WHERE stream_id = ?) and grouped by user_id in JS,
  // instead of one round-trip per member (N+1) — a space with many members
  // previously serialized N role queries on the space worker.
  const roleRows = await db
    .query(
      `select user_id, role_id from member_roles
        where stream_id = ?`,
    )
    .all<{ user_id: string; role_id: string }>([spaceId]);
  const rolesByUser = new Map<string, string[]>();
  for (const row of roleRows) {
    const list = rolesByUser.get(row.user_id) ?? [];
    list.push(row.role_id);
    rolesByUser.set(row.user_id, list);
  }

  const members: MemberRow[] = memberRows.map((r) =>
    stripNulls({
      did: r.did,
      handle: r.handle,
      name: r.name,
      avatar: r.avatar,
      isAdmin: !!r.is_admin,
      isBanned: !!r.is_banned,
      roleIds: rolesByUser.get(r.did) ?? [],
    }) as MemberRow,
  );

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
          )`,
    )
    .all<{ did: string; handle: string | null; name: string | null; avatar: string | null }>([spaceId]);

  const externalAdmins: ExternalAdminRow[] = externalAdminRows.map((r) =>
    stripNulls({
      did: r.did,
      handle: r.handle,
      name: r.name,
      avatar: r.avatar,
    }) as ExternalAdminRow,
  );

  // Resolve member/admin profiles from the global store (with an in-memory
  // cache). A member's profile entity lives in their own stream, not this
  // space's stream, so the per-space comp_user/comp_info join above is null
  // for cross-stream members. The global `profiles` table is authoritative;
  // the per-space value (if any) acts as a fallback.
  await hydrateProfiles(
    members,
    (m) => m.did,
    (m, p) => {
      if (p.name != null) m.name = p.name;
      if (p.handle != null) m.handle = p.handle;
      if (p.avatar != null) m.avatar = p.avatar;
    },
  );
  await hydrateProfiles(
    externalAdmins,
    (m) => m.did,
    (m, p) => {
      if (p.name != null) m.name = p.name;
      if (p.handle != null) m.handle = p.handle;
      if (p.avatar != null) m.avatar = p.avatar;
    },
  );

  // Apply the search filter AFTER hydration so cross-stream members (whose
  // handle/name only live in the global store) are matchable.
  return {
    members: members.filter((m) => memberMatchesSearch(m, search)),
    externalAdmins: externalAdmins.filter((m) =>
      memberMatchesSearch(m, search),
    ),
  };
}
