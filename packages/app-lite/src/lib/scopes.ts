/**
 * Scope definitions — the single source of truth for every OAuth scope string
 * the app produces:
 *
 *   - `SCOPE_SETS[tier]`    → the per-login authorization `scope` (auth.svelte.ts)
 *   - `FULL_SCOPE_CEILING`  → the `scope` field in the OAuth client metadata
 *                             (built by scripts/build-prod.sh)
 *
 * ## Two gates, not one
 *
 * A requested scope has to be allowed by *two* independently-deployed lists,
 * and the second one is easy to forget:
 *
 *  1. **The PDS metadata ceiling** (`FULL_SCOPE_CEILING`, served as
 *     `oauth-client-metadata.json`). Rebuilt from this file on every deploy.
 *     A request for a token that is not in it fails the *authorization* with
 *     `invalid_scope` — "Scope \"…\" is not declared in the client metadata".
 *
 *  2. **The HappyView API client's scope allowlist.** Provisioned out of band
 *     (dashboard, or `PUT /admin/api-clients/{id}`) and read from HappyView's
 *     database on every request. Roomy asks HappyView to custody the granted
 *     session at `POST /oauth/sessions`, and HappyView rejects the *whole*
 *     granted set when any one token is missing from the allowlist — after the
 *     user has already consented at their PDS:
 *
 *         400 {"error":"scope '<token>' is not allowed for this client"}
 *
 *     The client surfaces that as `OAuthCallbackError: Failed to register
 *     session`. Registration is what makes an account usable, so one
 *     unregistered token in `base` breaks sign-in for **every** user — not
 *     just the one who consented.
 *
 * A scope therefore moves through three states: declared in the ceiling, then
 * registered on the HappyView API client, then — only once both hold —
 * requested. The middle state is tracked here as {@link UNREGISTERED_SCOPES},
 * and `scripts/check-oauth-scopes.mjs` fails the build if a requestable tier
 * contains any token from it.
 *
 * That check is the whole point: the HappyView list cannot be derived from this
 * repo, so the only safe failure is a build that refuses to ship.
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
  "space.roomy.auth.getLoginScope",
  "space.roomy.auth.recordScopeGrant",
  "space.roomy.auth.getScopeSettings",
  "space.roomy.auth.setScopeSettings",
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
 * Voice RPCs. Voice Phase 1 shipped the server core only (see
 * `appserver/src/voice/`); nothing in app-lite calls these yet, and they are
 * not registered on the deployed HappyView API client. They are therefore
 * ceiling-only: declared so a future tier can request them without a metadata
 * rebuild, but listed in `UNREGISTERED_SCOPES` until the client allows them.
 */
const VOICE_NSIDS = [
  "space.roomy.voice.getToken",
  "space.roomy.voice.getParticipants",
  "space.roomy.voice.getActiveCalls",
  "space.roomy.voice.join",
  "space.roomy.voice.leave",
] as const;
const VOICE_SCOPES = VOICE_NSIDS.map((nsid) => `rpc:${nsid}?aud=*`);

/**
 * Blocks (`space.roomy.user.block`) are written to the blocker's own repo, so
 * blocking needs a `repo:` scope of its own.
 */
const BLOCK_SCOPES = ["repo:space.roomy.user.block"] as const;

/**
 * Scopes that are declared in the ceiling but NOT yet registered on the
 * deployed HappyView API client — requesting one of these fails.
 *
 * The drift check (`scripts/check-oauth-scopes.mjs`) fails the build if any
 * requestable tier contains a token from this list. That is what makes the
 * registration step impossible to skip: moving a feature's scopes into `base`
 * before the client lists them breaks CI rather than production sign-in.
 *
 * Remove a scope from here only after registering it on the client:
 *
 *   GET  /admin/api-clients                      # find the client id
 *   PUT  /admin/api-clients/{id}                 # {"scopes": "<existing scopes> <new>"}
 *
 * then move its tier from `DEFERRED_SCOPE_SETS` to `REQUESTABLE_SCOPE_SETS`.
 */
export const UNREGISTERED_SCOPES: readonly string[] = [
  ...BLOCK_SCOPES,
  ...VOICE_SCOPES,
];

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
 * Additional scopes for Semble cards written to the USER'S OWN repo. The
 * space-collection path (`createCosmikCard`, sdk/src/atproto/cosmik-card.ts)
 * goes through the arbiter proxy under `space.roomy.authComplete` and needs
 * none of these — which is why this tier is the first real test of progressive
 * expansion: the feature looks similar to one that already works, but this
 * half genuinely requires new consent. Phase 6 wires the personal
 * collection action to this tier.
 */
const SEMBLE_SCOPES = [
  "repo:network.cosmik.card?action=create",
] as const;

/**
 * Additional scopes for Bluesky DMs (chat.bsky.convo.* etc.). Not needed by
 * anything in-tree yet; kept as the shape a future tier takes so the
 * metadata ceiling already declares them (a scope must be in the client
 * metadata before it can ever be requested).
 */
const DM_NSIDS = [
  "chat.bsky.actor.deleteAccount",
  "chat.bsky.actor.exportAccountData",
  "chat.bsky.convo.acceptConvo",
  "chat.bsky.convo.deleteMessageForSelf",
  "chat.bsky.convo.getConvoAvailability",
  "chat.bsky.convo.getConvoForMembers",
  "chat.bsky.convo.getConvo",
  "chat.bsky.convo.getLog",
  "chat.bsky.convo.leaveConvo",
  "chat.bsky.convo.listConvos",
  "chat.bsky.convo.muteConvo",
  "chat.bsky.convo.removeReaction",
  "chat.bsky.convo.sendMessageBatch",
  "chat.bsky.convo.unmuteConvo",
  "chat.bsky.convo.addReaction",
  "chat.bsky.convo.updateAllRead",
  "chat.bsky.convo.updateRead",
  "chat.bsky.moderation.getActorMetadata",
  "chat.bsky.moderation.getMessageContext",
  "chat.bsky.moderation.updateActorAccess",
] as const;
/** The Bluesky chat appview's DID, as the DM rpc scopes' `aud`. */
const CHAT_APPVIEW_AUD = "did:web:api.bsky.chat%23bsky_chat";
const DM_SCOPES = DM_NSIDS.map((nsid) => `rpc:${nsid}?aud=${CHAT_APPVIEW_AUD}`);

/**
 * Tiers that may actually be requested in an authorization round-trip, because
 * every scope in them is registered on the deployed HappyView API client.
 *
 * This is the list the PDS is asked to grant, so it is also the list that must
 * stay inside the HappyView client's scope allowlist. A tier built from
 * anything else belongs in `DEFERRED_SCOPE_SETS`.
 */
export const REQUESTABLE_SCOPE_SETS = {
  base: BASE_SCOPES.join(" "),
  semble: [...BASE_SCOPES, ...SEMBLE_SCOPES].join(" "),
  withDms: [...BASE_SCOPES, ...DM_SCOPES].join(" "),
} as const;

/** Ceiling-only tiers: declared, but not yet registered on the client. */
const DEFERRED_SCOPE_SETS = {
  blocks: [...BASE_SCOPES, ...BLOCK_SCOPES].join(" "),
  voice: [...BASE_SCOPES, ...VOICE_SCOPES].join(" "),
} as const;

/**
 * The scope the blocks feature needs, by tier, for the profile page's consent
 * prompt. `blocks` is ceiling-only until its scope is registered on the
 * HappyView API client (see {@link UNREGISTERED_SCOPES}); this names it in one
 * place so the prompt and the gate cannot disagree.
 */
export const BLOCKS_SCOPE = BLOCK_SCOPES[0];

/**
 * Named scope tiers. Each tier is a superset of `base`. The later tiers exist
 * so a returning user who has already consented to them gets them requested
 * back on relogin (via the stored grant) with no re-prompt, and so the
 * metadata ceiling can declare every scope the app might ever want.
 */
export const SCOPE_SETS = {
  ...REQUESTABLE_SCOPE_SETS,
  ...DEFERRED_SCOPE_SETS,
} as const;

export type ScopeSetName = keyof typeof SCOPE_SETS;
export type RequestableScopeSetName = keyof typeof REQUESTABLE_SCOPE_SETS;

/**
 * Every token the OAuth client metadata may carry, in the exact order it ships.
 *
 * This is the union of all tier scopes plus the tokens that only belong in the
 * metadata ceiling (never requested directly at login): the arbiter proxy RPC,
 * and the build-time env-var-backed repo/aud tokens. It reproduces, byte for
 * byte, the `SCOPE` assembly that scripts/build-prod.sh historically
 * hand-maintained — the PDS enforces that a requested scope must exist here.
 *
 * The ceiling is the *PDS* gate: a requested token must appear here or the
 * authorization server refuses with `invalid_scope`. It is deliberately wider
 * than `REQUESTABLE_SCOPE_SETS`, which is the *HappyView* gate — see the
 * deferred-scopes note above.
 */
export const FULL_SCOPE_CEILING = [
  "atproto",
  "rpc:app.bsky.actor.getProfiles?aud=*",
  "rpc:app.bsky.actor.getProfile?aud=*",
  "blob:*/*",
  "repo:space.roomy.upload.v0",
  `repo:${profileSpaceNsid}`,
  "repo:space.roomy.user.profile",
  "repo:space.roomy.user.block",
  `rpc:com.atproto.server.getServiceAuth?aud=${appserverDid}`,
  "rpc:com.atproto.server.getServiceAuth?aud=*",
  "rpc:space.roomy.authComplete.arbiter.proxy?aud=*",
  "include:space.roomy.authComplete",
  ...APPSERVER_RPCS.map((nsid) => `rpc:${nsid}?aud=*`),
  ...VOICE_SCOPES,
  "repo:network.cosmik.card?action=create",
  ...DM_SCOPES,
].join(" ");

/**
 * The scope declared in the dev *loopback* OAuth client id
 * (`http://localhost?redirect_uri=…&scope=…`).
 *
 * The PDS derives the loopback client's metadata — including its scope
 * ceiling — from the client id, records that exact client id with the
 * authorization request, and requires every later token exchange/refresh to
 * present it unchanged (else `invalid_grant: Token was not issued to this
 * client`). Because the client id embeds its scope, that scope must be
 * identical on the `login()` that starts the flow, the `init()` that processes
 * the callback, and every session restore/refresh — all of which build their
 * OAuth client independently. It therefore cannot be a per-login value like
 * `reconcileScope(stored)` or `SCOPE_SETS[tier]`; it is the app's full,
 * constant ceiling, a superset of every scope any login may request.
 *
 * Only meaningful for the loopback client (local dev, no deployed metadata);
 * deployed/HappyView builds use the metadata document URL as the client id and
 * never read this. The per-request `scope` still selects the subset shown on
 * the consent screen.
 */
export const CLIENT_ID_SCOPE = FULL_SCOPE_CEILING;

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
