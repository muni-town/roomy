/**
 * OAuth scope definitions — the single source of truth for every scope string
 * the app produces:
 *
 *   - `SCOPE_SETS.base`  → the per-login authorization `scope` (auth.svelte.ts)
 *   - `FULL_SCOPE_CEILING` → the `scope` field in the OAuth client metadata
 *                            (built by scripts/build-prod.sh)
 *
 * The ceiling is the union of every tier (today that is just `base` plus the
 * extra tokens only the metadata may carry — e.g. the arbiter proxy RPC the
 * client never mints directly, and the build-time env-var-backed tokens). The
 * PDS enforces that every requested scope exists in the metadata ceiling, and
 * the consent screen only ever shows the requested subset, never the ceiling.
 *
 * This module is deliberately free of `config.ts` and `$env` imports:
 * `config.ts` pulls in SvelteKit's `$env/dynamic` and Vite's `import.meta.env`,
 * neither of which the Node unit-test runner (`node --test
 * --experimental-strip-types`) can resolve. The two env-dependent tokens
 * (appserver DID, stream-handle NSID) are read inline with the same defaults
 * config.ts and build-prod.sh use; build-prod.sh re-applies its VITE_* env
 * overrides when it derives the ceiling.
 */

// `import.meta.env` is Vite-typed with only the statically-known VITE_* vars;
// these two are optional build overrides with defaults, so read them through a
// generic string map instead of the closed ImportMetaEnv type. In Node
// (unit tests, build-prod.sh) `import.meta.env` is undefined and the VITE_*
// values instead arrive via process.env — so both are consulted.
const viteEnv =
  (import.meta.env as Record<string, string | undefined> | undefined) ?? {};
const procEnv =
  (typeof process === "undefined"
    ? {}
    : process.env) as Record<string, string | undefined>;

function scopeEnv(key: string, fallback: string): string {
  const fromVite = viteEnv[key];
  if (fromVite) return fromVite;
  return procEnv[key] || fallback;
}

const appserverDid = scopeEnv(
  "VITE_APPSERVER_DID",
  "did:web:api.roomy.space",
);
const profileSpaceNsid = scopeEnv(
  "VITE_STREAM_HANDLE_NSID",
  "space.roomy.space.handle.dev",
);

/**
 * All appserver RPCs the thin client calls. These become `rpc:<nsid>?aud=*`
 * scopes. Kept in metadata-ceiling order (matching the historical
 * build-prod.sh assembly) so the shipped ceiling is byte-identical to before
 * the refactor; scope order is not semantically significant.
 */
const APPSERVER_RPCS = [
  "space.roomy.space.getSpaces",
  "space.roomy.space.getMetadata",
  "space.roomy.space.getSpaceSummary",
  "space.roomy.space.getThreads",
  "space.roomy.space.getRoles",
  "space.roomy.space.getMembers",
  "space.roomy.space.getInvites",
  "space.roomy.room.getMetadata",
  "space.roomy.room.getRoomSummary",
  "space.roomy.room.getMessages",
  "space.roomy.room.getThreads",
  "space.roomy.message.getMessage",
  "space.roomy.message.getReactions",
  "space.roomy.auth.getConnectionTicket",
  "space.roomy.getFlags",
  "space.roomy.room.updateSeen",
  "space.roomy.space.sendEvents",
  "space.roomy.space.createSpace",
  "space.roomy.space.joinSpace",
  "space.roomy.space.leaveSpace",
  "space.roomy.space.reorderSpaces",
  "space.roomy.space.setHandle",
  "space.roomy.space.updatePolicy",
  "space.roomy.space.getCalendarLink",
  "space.roomy.space.getCalendarEvents",
  "space.roomy.space.getActivityFeed",
  "space.roomy.search.messages",
  "space.roomy.search.rooms",
  "space.roomy.user.getProfile",
  "space.roomy.user.getMembershipStatus",
  "space.roomy.embed.getLinkMetadata",
  "space.roomy.space.getLinks",
  "space.roomy.room.getLinks",
  "space.roomy.federation.getRequests",
  "space.roomy.federation.getIncoming",
  "space.roomy.federation.getOutgoing",
  "space.roomy.federation.getGrants",
  "space.roomy.push.getVapidPublicKey",
  "space.roomy.push.getPreferences",
  "space.roomy.pro.createCheckout",
  "space.roomy.push.registerSubscription",
  "space.roomy.push.unregisterSubscription",
  "space.roomy.push.setPreferences",
  "space.roomy.space.getBridgeTokens",
  "space.roomy.space.grantBridgeToken",
  "space.roomy.space.revokeBridgeToken",
] as const;

/**
 * Scopes required by all Roomy core functionality. Reproduces, byte for byte,
 * the historical `OAUTH_SCOPE` from config.ts — the per-login request.
 */
const BASE_SCOPES = [
  "atproto",
  // Profile reads are public data; allow any appview (Bluesky, Blacksky,
  // Eurosky, etc.) so users whose PDS routes to a non-Bluesky appview can
  // still fetch profiles. lxm is pinned to the specific NSID, so this only
  // grants read access to these two endpoints — not a blanket appview grant.
  "rpc:app.bsky.actor.getProfiles?aud=*",
  "rpc:app.bsky.actor.getProfile?aud=*",
  "blob:*/*",
  "repo:space.roomy.upload.v0", // Grant all actions (create, update, delete)
  "repo:space.roomy.user.profile",
  "include:space.roomy.authComplete",
  `repo:${profileSpaceNsid}`,
  // Allow calling getServiceAuth on the appserver's PDS to obtain
  // service auth tokens for direct (non-proxied) XRPC calls.
  `rpc:com.atproto.server.getServiceAuth?aud=${appserverDid}`,
  // Allow obtaining serviceAuth tokens targeted at any arbiter server (the
  // arbiter DID is discovered per space from its service record), so the
  // client can call `space.roomy.authComplete.arbiter.proxy` directly (acting
  // on a space's stewarded account). aud=* because the arbiter DID is
  // per-space.
  `rpc:com.atproto.server.getServiceAuth?aud=*`,
  ...APPSERVER_RPCS.map((nsid) => `rpc:${nsid}?aud=*`),
] as const;

/**
 * Named scope tiers. Each tier is a superset of the previous. The `base` tier
 * is what we request at first login.
 */
export const SCOPE_SETS = {
  base: BASE_SCOPES.join(" "),
} as const;

export type ScopeSetName = keyof typeof SCOPE_SETS;

/**
 * Every token the OAuth client metadata may carry, in the exact order it ships.
 *
 * This is the union of all tier scopes plus the tokens that only belong in the
 * metadata ceiling (never requested directly at login): the arbiter proxy RPC,
 * and the build-time env-var-backed repo/aud tokens. It reproduces, byte for
 * byte, the `SCOPE` assembly that scripts/build-prod.sh historically
 * hand-maintained — the PDS enforces that a requested scope must exist here.
 */
export const FULL_SCOPE_CEILING = [
  "atproto",
  "rpc:app.bsky.actor.getProfiles?aud=*",
  "rpc:app.bsky.actor.getProfile?aud=*",
  "blob:*/*",
  "repo:space.roomy.upload.v0",
  `repo:${profileSpaceNsid}`,
  "repo:space.roomy.user.profile",
  `rpc:com.atproto.server.getServiceAuth?aud=${appserverDid}`,
  "rpc:com.atproto.server.getServiceAuth?aud=*",
  "rpc:space.roomy.authComplete.arbiter.proxy?aud=*",
  "include:space.roomy.authComplete",
  ...APPSERVER_RPCS.map((nsid) => `rpc:${nsid}?aud=*`),
].join(" ");

/** Parse a scope string into a Set of individual scope tokens. */
export function parseScopes(scope: string): Set<string> {
  return new Set(scope.split(" ").filter(Boolean));
}

/** True if every scope in the named tier is present in `grantedScope`. */
export function hasScopeSet(grantedScope: string, tier: ScopeSetName): boolean {
  const required = parseScopes(SCOPE_SETS[tier]);
  const granted = parseScopes(grantedScope);
  for (const s of required) if (!granted.has(s)) return false;
  return true;
}

/**
 * Reconcile a stored scope (from a previous login or the server) against the
 * current ceiling and base tier:
 *
 *   1. Always include `base` (minimum functionality).
 *   2. Include stored scopes that are still in `ceiling` (drops tokens we no
 *      longer request — requesting one the metadata no longer declares would
 *      make the PDS reject with invalid_scope).
 *   3. Results are deduped. Order: base order first, then any extra stored
 *      scopes still within the ceiling (a superset in no guaranteed order).
 */
export function reconcileScope(
  stored: string,
  baseScope: string = SCOPE_SETS.base,
  ceiling: string = FULL_SCOPE_CEILING,
): string {
  const ceilingSet = parseScopes(ceiling);
  const baseSet = parseScopes(baseScope);
  const storedSet = parseScopes(stored);

  const result = new Set<string>();
  for (const s of baseSet) result.add(s);
  for (const s of storedSet) if (ceilingSet.has(s)) result.add(s);
  return [...result].join(" ");
}
