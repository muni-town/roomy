/**
 * Statement routing for the per-space DB split.
 *
 * Materializer statements are opaque SQL, so the target DB is derived from
 * the statement text. The rule is deliberately narrow:
 *
 * - `edges` statements mentioning `'joinedSpace'` or `'leftSpace'` are the
 *   per-user membership edges written by the `JoinSpace`/`LeaveSpace`
 *   materialisers (space.roomy.space.joinSpace/leaveSpace). They
 *   live in the global DB only.
 * - `space_federations` / `federation_room_permissions` /
 *   `federation_receiver_permissions` statements (written by the federation
 *   materialisers, space.roomy.federation.*) are the cross-space
 *   channel-federation registry + grants. They live in the global DB only.
 * - Everything else — `entities`, `comp_*`, `roles`, `activity_item`,
 *   `materialization_cursor`, and all other `edges` labels (member, admin,
 *   author, link, reply, forward, ...) — lives in the per-space DB.
 *
 * The set of global-DB statements is small and stable, so text matching is
 * the pragmatic approach.
 */

/** True when the statement writes the global membership edges or registry. */
export function isGlobalDbStatement(sql: string): boolean {
  if (
    sql.includes("space_federations") ||
    sql.includes("federation_room_permissions") ||
    sql.includes("federation_receiver_permissions")
  ) {
    return true;
  }
  if (!sql.includes("edges")) return false;
  return sql.includes("'joinedSpace'") || sql.includes("'leftSpace'");
}
