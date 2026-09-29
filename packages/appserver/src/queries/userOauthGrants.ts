/**
 * Per-user OAuth scope grants, stored in the read-state DB (`user_oauth_grants`,
 * schema v11).
 *
 * The stored value is the raw scope string the PDS actually granted (from
 * `OAuthSession.getTokenInfo().scope`), captured by the client after every
 * login/expansion and written by the `recordScopeGrant` procedure. The
 * `getLoginScope` query reads it back so a returning user's `signIn()` can
 * request the exact scope they already approved — one round-trip, no
 * re-prompting for permissions already granted.
 *
 * LAST-GRANTED, not a high-water mark: a user who narrows consent on the PDS
 * consent screen must not be silently re-granted the removed scopes on next
 * login. Tiers are a client-side UX abstraction; this module never
 * interprets the string.
 *
 * State lives in the read-state DB (not the materialisation DB) so it
 * survives materialisation resets — see `db/readStateSchema.sql`.
 */

import type { DbLike } from "../db/types.ts";

/** The stored grant for one user, or null when the user has never recorded one. */
export async function selectGrantedScope(
  db: DbLike,
  userDid: string,
): Promise<string | null> {
  const row = await db
    .query("select granted_scope from user_oauth_grants where user_did = ?")
    .get<{ granted_scope: string }>(userDid);
  return row?.granted_scope ?? null;
}

/**
 * Upsert the user's granted scope. The client calls this after every
 * login/expansion, so it runs repeatedly for the same user — an upsert, not
 * an insert. Overwrites with the latest consent, including narrowing.
 */
export async function upsertGrantedScope(
  db: DbLike,
  userDid: string,
  grantedScope: string,
): Promise<void> {
  await db.run(
    `insert into user_oauth_grants (user_did, granted_scope, updated_at)
     values (?, ?, unixepoch() * 1000)
     on conflict(user_did) do update set
       granted_scope = excluded.granted_scope,
       updated_at = excluded.updated_at`,
    userDid,
    grantedScope,
  );
}
