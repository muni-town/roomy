/**
 * Pending OAuth scope-expansion intents, stored in the read-state DB
 * (`user_scope_intents`, schema v12).
 *
 * A pending intent is the desired raw scope string a user *requested* via
 * `space.roomy.auth.setScopeSettings` but the PDS has not yet confirmed.
 * Granting a wider scope requires the client-driven PDS consent round-trip, so
 * the endpoint only records the request. Once `recordScopeGrant` writes the
 * actual (confirmed) grant, the intent is cleared so it does not resurface on
 * a later `getScopeSettings` (the grant itself is then the source of truth).
 *
 * The stored value is a raw scope string, never a tier name — mirroring
 * `user_oauth_grants`.
 */

import type { DbLike } from "../db/types.ts";

/** The pending expansion intent for one user, or null when none is pending. */
export async function selectRequestedScope(
  db: DbLike,
  userDid: string,
): Promise<string | null> {
  const row = await db
    .query("select requested_scope from user_scope_intents where user_did = ?")
    .get<{ requested_scope: string }>(userDid);
  return row?.requested_scope ?? null;
}

/** Record (or replace) the user's pending expansion intent. */
export async function upsertRequestedScope(
  db: DbLike,
  userDid: string,
  requestedScope: string,
): Promise<void> {
  await db.run(
    `insert into user_scope_intents (user_did, requested_scope, updated_at)
     values (?, ?, unixepoch() * 1000)
     on conflict(user_did) do update set
       requested_scope = excluded.requested_scope,
       updated_at = excluded.updated_at`,
    userDid,
    requestedScope,
  );
}

/** Clear the user's pending expansion intent (idempotent; no-op if none). */
export async function clearRequestedScope(
  db: DbLike,
  userDid: string,
): Promise<void> {
  await db.run("delete from user_scope_intents where user_did = ?", userDid);
}
