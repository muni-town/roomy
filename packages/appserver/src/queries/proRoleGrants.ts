/**
 * Roomy Pro members-area role grants, stored in the read-state DB.
 *
 * The reconcile sweep (billing/proRoleReconcile.ts) adds paying Roomy Pro
 * subscribers to the 'Members' role in the Roomy Space and removes them
 * when their subscription lapses. This table tracks the DIDs the sweep
 * itself granted — it is the ownership record that lets the sweep remove a
 * lapsed subscriber WITHOUT ever clobbering a manually-assigned member who
 * is not a subscriber. Removal only applies to a tracked DID
 * whose subscription has lapsed; a manually-granted non-subscriber is left
 * untouched.
 */

import type { DbLike } from "../db/types.ts";

/** A tracked row: a DID the sweep granted the Members role. */
export interface ProRoleGrantRow {
  did: string;
  granted_at: number;
}

/**
 * Return all DIDs currently tracked as sweep-granted members, oldest first.
 */
export async function selectProRoleGrants(
  db: DbLike,
): Promise<ProRoleGrantRow[]> {
  return db
    .query(
      `select did, granted_at from pro_role_grants order by granted_at asc`,
    )
    .all<ProRoleGrantRow>();
}

/**
 * Return whether `did` is tracked as a sweep-granted member.
 */
export async function hasProRoleGrant(
  db: DbLike,
  did: string,
): Promise<boolean> {
  const row = await db
    .query("select 1 as n from pro_role_grants where did = ?")
    .get<{ n: number }>(did);
  return row !== null;
}

/**
 * Record that the sweep granted `did` the Members role. Idempotent.
 */
export async function insertProRoleGrant(
  db: DbLike,
  did: string,
): Promise<void> {
  await db.run(
    `insert or ignore into pro_role_grants (did, granted_at) values (?, ?)`,
    did,
    Date.now(),
  );
}

/**
 * Stop tracking `did` (removed from the Members role by the sweep).
 * Returns whether a row was deleted.
 */
export async function deleteProRoleGrant(
  db: DbLike,
  did: string,
): Promise<boolean> {
  const res = await db.run("delete from pro_role_grants where did = ?", did);
  return (res.changes ?? 0) > 0;
}
