/**
 * Global `space_stats` — the cross-space member-count aggregate the admin
 * dashboard's space list sorts on.
 *
 * A space's member count is a count over its OWN per-space DB
 * (`edges where head = space and label in ('member','admin')`). The dashboard
 * sorts spaces by it, so deriving it per request meant opening every space's
 * DB — O(all spaces) per request, ~19 s on a 4276-space dataset. This module
 * keeps the number precomputed in the global DB instead, so the read path
 * touches only the page it returns.
 *
 * Two functions rather than one, because the two DBs live on different pool
 * workers and a caller usually holds the handles it needs already: a space
 * handle for the count (its edges are in the space's DB) and the global handle
 * for the write. `applyBatch` in particular receives both and cannot reach the
 * global DB through its space handle.
 *
 * A row is written for every space that is swept, INCLUDING a count of zero.
 * That is deliberate: it makes "no row" mean "this space has never been
 * swept", which the read path can detect and repair, instead of being
 * ambiguous with "a space with no members" (the common case — on the reference
 * dataset 2715 of 4276 spaces have none).
 */

import type { DbLike } from "../db/types.ts";

/**
 * Count a space's member/admin edges in its own DB.
 *
 * The count is GATED ON A `comp_space` ROW for the space, which is what the
 * pre-aggregate handler did: it selected from `comp_space` and fell back to 0
 * when the space had no row there, so a space with member edges but no
 * `comp_space` row reported `memberCount: 0`. On the reference dataset that is
 * most of them (~2700 of 4276 — spaces materialised from a joined
 * `spaceMeta` synthetic event, whose own stream never produced the
 * `createSpace` that writes `comp_space`). The gate is preserved deliberately:
 * changing it would move ~2700 rows on the dashboard's member-count ordering,
 * which is a product decision, not a performance one.
 *
 * Member and admin are counted as a union: every member edge counts once, and
 * an admin with no member edge is still a member. The two labels differ only in
 * payload (`{"can":"admin"}` vs `{"can":"post"}`) and the materialisers write a
 * `member` edge alongside every `admin` one, but the union keeps the number
 * right where they drift.
 */
export async function selectMemberCount(
  spaceDb: DbLike,
  spaceDid: string,
): Promise<number> {
  const row = await spaceDb
    .query(
      `select (select count(*) from edges
                where head = cs.entity and label in ('member','admin')
               ) as member_count
         from comp_space cs
        where cs.entity = ?`,
    )
    .get<{ member_count: number }>(spaceDid);
  return row?.member_count ?? 0;
}

/** Upsert a space's aggregate row in the global DB. */
export async function recordSpaceStats(
  globalDb: DbLike,
  spaceDid: string,
  memberCount: number,
): Promise<void> {
  await globalDb.run(
    `insert into space_stats (space_did, member_count, updated_at)
     values (?, ?, ?)
     on conflict (space_did) do update set
       member_count = excluded.member_count,
       updated_at = excluded.updated_at`,
    spaceDid,
    memberCount,
    Date.now(),
  );
}

/**
 * Recompute and store one space's aggregate row, given a handle that can reach
 * both that space's DB and the global DB (e.g. the `openDb()` router).
 */
export async function refreshSpaceStats(
  db: DbLike,
  spaceDid: string,
): Promise<number> {
  const spaceDb = db.forSpace?.(spaceDid);
  const globalDb = db.global?.();
  if (!spaceDb || !globalDb) return 0;
  const memberCount = await selectMemberCount(spaceDb, spaceDid);
  await recordSpaceStats(globalDb, spaceDid, memberCount);
  return memberCount;
}
