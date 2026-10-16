/**
 * Roomy Pro bridge-token grants, stored in the read-state DB (schema v9).
 *
 * One `bridge_token_grants` row per grantor (primary key = grantor DID):
 * a Pro subscriber grants their single bridge token to a space, and the
 * grant powers a guild-space bridge up to the granted capacity. A grant is
 * "spent" when the bridged guild's member count exceeds 100 (spent_at set,
 * PERMANENT), which locks the token to that guild — it can no longer be
 * revoked or granted elsewhere — but does not reduce its capacity. Written
 * by the grantBridgeToken / revokeBridgeToken procedures + the admin
 * getSpaceMembership spend rule; read by getBridgeTokens and the admin
 * endpoint.
 */

import type { DbLike } from "../db/types.ts";

/** A stored grant row. `spentAt === null` → active (pending). */
export interface BridgeTokenGrantRow {
  grantor_did: string;
  space_did: string;
  granted_at: number;
  spent_at: number | null;
  capacity_snapshot: number;
}

/**
 * Return every grant row for a space, newest first. Caller is responsible
 * for access control.
 */
export async function selectGrantsForSpace(
  db: DbLike,
  spaceDid: string,
): Promise<BridgeTokenGrantRow[]> {
  return db
    .query(
      `select grantor_did, space_did, granted_at, spent_at, capacity_snapshot
         from bridge_token_grants
        where space_did = ?
        order by granted_at asc`,
    )
    .all<BridgeTokenGrantRow>(spaceDid);
}

/**
 * Return the grant row for a grantor, or null when they have no grant.
 */
export async function selectGrantForGrantor(
  db: DbLike,
  grantorDid: string,
): Promise<BridgeTokenGrantRow | null> {
  return db
    .query(
      `select grantor_did, space_did, granted_at, spent_at, capacity_snapshot
         from bridge_token_grants
        where grantor_did = ?`,
    )
    .get<BridgeTokenGrantRow>(grantorDid);
}

/**
 * Insert a new pending grant. Caller has already enforced one-grant-per-user.
 */
export async function insertGrant(
  db: DbLike,
  grant: {
    grantor_did: string;
    space_did: string;
    capacity_snapshot: number;
  },
): Promise<void> {
  await db.run(
    `insert into bridge_token_grants (grantor_did, space_did, granted_at, capacity_snapshot)
     values (?, ?, ?, ?)`,
    [grant.grantor_did, grant.space_did, Date.now(), grant.capacity_snapshot],
  );
}

/**
 * Delete a grantor's grant. Returns whether a row was deleted.
 */
export async function deleteGrant(
  db: DbLike,
  grantorDid: string,
): Promise<boolean> {
  const res = await db.run(
    "delete from bridge_token_grants where grantor_did = ?",
    grantorDid,
  );
  return (res.changes ?? 0) > 0;
}

/**
 * Mark a grant spent (permanent). Returns whether a row was updated.
 */
export async function markGrantSpent(
  db: DbLike,
  grantorDid: string,
): Promise<boolean> {
  const res = await db.run(
    "update bridge_token_grants set spent_at = ? where grantor_did = ? and spent_at is null",
    Date.now(),
    grantorDid,
  );
  return (res.changes ?? 0) > 0;
}
