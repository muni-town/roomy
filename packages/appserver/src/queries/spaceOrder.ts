/**
 * Per-user space ordering, stored in the read-state DB (schema v7).
 *
 * One `space_order` row per (user, space); `position` is the 0-based index
 * in the user's space list. Absent rows fall back to the default ordering
 * (membership `updated_at desc`). Written by the reorderSpaces procedure,
 * read by getSpaces.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, UserDid } from "@roomy-space/sdk";

export interface SpaceOrderRow {
  space_did: string;
  position: number;
}

/**
 * Return the user's stored space order, keyed by space DID. Only spaces the
 * user has actually joined are returned (left spaces are excluded — they
 * aren't part of the reorderable list).
 */
export async function selectSpaceOrder(
  db: DbLike,
  userDid: UserDid,
): Promise<Map<string, number>> {
  const rows = await db
    .query(
      `select so.space_did, so.position
         from space_order so
         join user_space_membership usm
           on usm.user_did = so.user_did and usm.space_did = so.space_did
        where so.user_did = ? and usm.state = 'joined'
        order by so.position asc`,
    )
    .all<SpaceOrderRow>([userDid]);
  return new Map(rows.map((r) => [r.space_did, r.position]));
}

/**
 * Replace the user's space order with `spaceDids` (in list order). Runs in a
 * transaction: deletes the user's existing rows, then inserts the new ones.
 * Idempotent — reordering to the same order is a no-op write-wise.
 */
export async function replaceSpaceOrder(
  db: DbLike,
  userDid: UserDid,
  spaceDids: readonly StreamDid[],
): Promise<void> {
  const now = Date.now();
  await db.transaction([
    {
      type: "run",
      sql: "delete from space_order where user_did = ?",
      params: [userDid],
    },
    ...spaceDids.map((spaceDid, position) => ({
      type: "run" as const,
      sql: `insert into space_order (user_did, space_did, position, updated_at)
            values (?, ?, ?, ?)`,
      params: [userDid, spaceDid, position, now],
    })),
  ]);
}
