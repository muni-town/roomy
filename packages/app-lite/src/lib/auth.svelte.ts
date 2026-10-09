import { Agent, AtpAgent } from "@atproto/api";
import {
  initSession,
  login as sdkLogin,
  logout as sdkLogout,
  type OAuthSession,
} from "@roomy-space/sdk/browser";
import { transport } from "@roomy-space/sdk";
import { goto } from "$app/navigation";
import { CONFIG } from "./config";
import {
  CLIENT_ID_SCOPE,
  FULL_SCOPE_CEILING,
  SCOPE_SETS,
  hasScopeSet,
  scopeWithinCeiling,
  type RequestableScopeSetName,
  type ScopeSetName,
} from "./scopes";
import {
  APP_PASSWORD_GRANTED_SCOPE,
  decideLoginScope,
  decideScopeReauthIdentity,
} from "./scope-grant";
import { scheduleAutoReload } from "./error-recovery";
import { pxUnauth } from "./client";
import { clearPersistedCache } from "./client";
import { setAppserverOrigin } from "./appserver-origin";
import { subscribeIfAlreadyPermitted, clearPushSubscription } from "./push.svelte";
import { saveLastLogin } from "./last-login.svelte";
import {
  consumeReturnUrl,
  hasOAuthCallbackParams,
  rememberReturnUrl,
} from "./return-url";

const { ServiceAuthClient, DirectXrpcClient, resolveAppserverHttpOrigin } = transport;

let agent = $state<Agent | null>(null);
let session = $state<OAuthSession | null>(null);
/** When set, `agent` is an AtpAgent logged in via app password (test mode). */
let appPasswordAgent = $state<AtpAgent | null>(null);
let authenticated = $state(false);
let initializing = $state(true);
let initError = $state<string | null>(null);
/**
 * The OAuth scope string the current session's token was actually granted
 * (from `session.getTokenInfo().scope`, which reflects any narrowing the user
 * did on the PDS consent screen). `null` when there is no token to introspect:
 * signed out, still initializing, or the app-password (test-mode) path — an
 * app-password session has no OAuth token, so it is always treated as
 * fully granting the requested tier (and `recordScopeGrant` is NOT sent, since
 * there is no PDS grant to record).
 */
let grantedScope = $state<string | null>(null);
/** The handle the current auth flow/expansion is keyed to (for re-auth). */
let currentHandle = $state<string>("");
export function isAuthenticated(): boolean {
  return authenticated;
}
export function isInitializing(): boolean {
  return initializing;
}

/** Cached profile for the current session, set reactively after login. */
let profile = $state<{ handle: string; did: string; avatar: string; displayName?: string } | null>(null);

// Direct XRPC client, created lazily once the agent is available.
let serviceAuth: InstanceType<typeof ServiceAuthClient> | null = null;
let directXrpc: InstanceType<typeof DirectXrpcClient> | null = null;

export const auth = {
  get agent() {
    return agent;
  },
  get session() {
    return session;
  },
  /**
   * The authenticated user's DID. Works for both OAuth and app-password auth
   * (OAuth exposes `session.did`; app-password only has `agent.did`).
   */
  get userDid() {
    return session?.did ?? agent?.did ?? undefined;
  },
  get authenticated() {
    return authenticated;
  },
  /** True while `init()` is in progress (session restoration / OAuth callback). */
  get initializing() {
    return initializing;
  },
  get initError() {
    return initError;
  },
  /** The granted OAuth scope string, or null when there is no OAuth token. */
  get grantedScope() {
    return grantedScope;
  },
  /**
   * True when the current session's granted scope covers every token in the
   * named tier. A `null` granted scope (signed out / not yet introspected)
   * is treated as lacking the tier. In app-password (test-mode) mode the
   * granted scope is set to the requested tier, so `hasScope` reports true
   * for it.
   */
  hasScope(tier: Parameters<typeof hasScopeSet>[1]) {
    return grantedScope !== null && hasScopeSet(grantedScope, tier);
  },
  /** Reactive profile for the current session (handle + DID + avatar). */
  get profile() {
    return profile;
  },
};

/** The current page location (path + query + hash), a return-URL candidate. */
function currentReturnUrl(): string {
  return location.pathname + location.search + location.hash;
}

/**
 * Wire up the ServiceAuthClient + DirectXrpcClient for an authenticated agent.
 * Shared by the OAuth path (init) and the app-password path (loginWithAppPassword).
 */
async function setupDirectXrpc(authAgent: Agent) {
  serviceAuth = new ServiceAuthClient(authAgent);
  // Local dev: when an HTTP origin override is set (derived from
  // VITE_APPSERVER_WS_ORIGIN), send XRPC to the local appserver instead of
  // resolving the DID to production. Keeps queries/procedures and the sync
  // WS pointed at the same local server.
  const appserverUrl =
    CONFIG.appserverHttpOrigin ??
    (await resolveAppserverHttpOrigin(CONFIG.appserverDid));
  setAppserverOrigin(appserverUrl);
  directXrpc = new DirectXrpcClient(appserverUrl, CONFIG.appserverDid, serviceAuth);
}

/**
 * Authenticate via ATProto app password (test mode). Creates an AtpAgent,
 * logs in, and wires up the same ServiceAuthClient + DirectXrpcClient as the
 * OAuth path. Used when PUBLIC_TEST_IDENTIFIER + PUBLIC_TEST_APP_PASSWORD are
 * set in the build env, enabling headless E2E testing without the OAuth
 * round-trip (which requires a publicly-exposed redirect URI).
 *
 * The PDS comes from `PUBLIC_PDS` so the test account does not have to live on
 * bsky.social; app passwords are PDS-scoped, so a self-hosted account only
 * authenticates against its own PDS.
 */
async function loginWithAppPassword(identifier: string, password: string) {
  const atpAgent = new AtpAgent({ service: CONFIG.testPds });
  await atpAgent.login({ identifier, password });
  if (!atpAgent.did) throw new Error("App password login failed — no DID");

  appPasswordAgent = atpAgent;
  agent = atpAgent;
  await setupDirectXrpc(atpAgent);
  // App-password path has no OAuth session/token, so there is no PDS grant to
  // introspect or record. Treat the full requested tier as granted so feature
  // gates (`auth.hasScope`) work identically in test/E2E mode. `grantedScope`
  // being a non-null value also means a stray getTokenInfo is never reached.
  grantedScope = APP_PASSWORD_GRANTED_SCOPE;
  authenticated = true;
}

/**
 * Introspect the current OAuth session's granted scope and sync it to the
 * appserver. Called once per successful OAuth init/relogin.
 *
 *  1. `session.getTokenInfo()` returns the *actually granted* scope (including
 *     any narrowing on the PDS consent screen) — stored reactively so feature
 *     gates (`auth.hasScope`) can check capability before use.
 *  2. `space.roomy.auth.recordScopeGrant` upserts that raw scope on the
 *     appserver (last-granted), so the next login can request it back with no
 *     re-prompt. Fire-and-forget: a failure is non-fatal — the session works
 *     regardless and self-heals on next login.
 *
 * Only meaningful for a real OAuth session (`getTokenInfo` lives on
 * `OAuthSession`); the app-password path never reaches this.
 */
async function trackGrant(oauthSession: OAuthSession) {
  try {
    const tokenInfo = await oauthSession.getTokenInfo(false);
    grantedScope = tokenInfo.scope ?? null;
  } catch (err) {
    // Failed introspection must not kill init — the session is still valid.
    console.warn("Failed to read granted scope:", err);
    return;
  }
  if (grantedScope) {
    try {
      await px().procedure("space.roomy.auth.recordScopeGrant", {
        scope: grantedScope!,
      });
    } catch (err) {
      // Non-fatal: the grant self-heals on next login.
      console.warn("Failed to record scope grant:", err);
    }
  }
}

/**
 * Hard cap on how long `init()` may take. The atproto OAuth client has no
 * timeout on the callback token exchange / DID resolution / session restore,
 * so a hung authorization server (or a network request that never settles) can
 * otherwise leave `initializing` stuck at `true` forever. The layout renders a
 * full-screen loading overlay while that's true — which on iOS Safari can
 * appear as a blank white page that is unrecoverable in the installed PWA (no
 * address bar to reload). The watchdog below converts that hang into a normal
 * `initError`, so the user gets a recovery UI instead of a blank screen.
 */
const INIT_TIMEOUT_MS = 15_000;

export async function init() {
  // The real init work, raced against a watchdog below. Kept separate so the
  // watchdog can fire without aborting the (possibly still-in-flight) exchange,
  // and so a successful-but-slow result can recover afterwards.
  const doInit = async () => {
    // Test mode: if app-password credentials are baked into the build env,
    // auto-login via app password instead of attempting OAuth session restore.
    // This bypasses the OAuth round-trip entirely, enabling headless E2E
    // testing against a local appserver without a publicly-exposed redirect.
    if (CONFIG.testIdentifier && CONFIG.testAppPassword) {
      await loginWithAppPassword(CONFIG.testIdentifier, CONFIG.testAppPassword);
      // Re-register this device's push subscription in case the browser
      // rotated the endpoint (Chrome/FCM does this periodically). No-op if
      // push is unsupported/unconfigured or permission was never granted.
      void subscribeIfAlreadyPermitted();
      return;
    }

    // Read the callback marker BEFORE `initSession`: either client rewrites
    // the address bar (dropping the query) as it processes the callback, so
    // the signal is gone by the time the session resolves.
    const oauthCallback = hasOAuthCallbackParams(location.search);
    const result = await initSession({
      happyviewEndpoint: CONFIG.happyviewEndpoint,
      clientKey: CONFIG.happyviewClientKey,
      clientId: CONFIG.oauthClientId,
      port: CONFIG.port,
      handleResolverUrl: CONFIG.handleResolverUrl,
      scope: SCOPE_SETS.base,
      // Stable dev-loopback client-id scope (see CLIENT_ID_SCOPE): the PDS
      // records the client id with the authorization request, so the callback
      // must rebuild the identical one. The per-login `scope` above selects
      // the subset shown on the consent screen.
      clientIdScope: CLIENT_ID_SCOPE,
    });
    if (result) {
      session = result.session;
      agent = result.agent;
      await setupDirectXrpc(result.agent);
      authenticated = true;

      // Introspect the granted scope and sync it to the server (fire-and-forget
      // recording; see trackGrant). Guarded to the OAuth path — the app-password
      // branch returns above and has no real grant.
      void trackGrant(result.session);

      // Verify a pending scope expansion (set before navigating to the PDS
      // consent screen in requestScopeExpansion) actually took. If the user
      // refused or the PDS narrowed, clear the flag so it doesn't linger — the
      // settings page reads the actual `grantedScope` for true state.
      const pending = isScopeExpansionPending();
      if (pending) {
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.removeItem(PENDING_EXPANSION_KEY);
        }
        if (grantedScope === null || !hasScopeSet(grantedScope, pending)) {
          console.warn(`Scope expansion to "${pending}" was not granted`);
        }
      }

      // After an OAuth callback the browser lands on the fixed redirect URI
      // (the homepage). `login()` stored the page the user came from; navigate
      // back to it now. Only on an actual callback: a plain session restore
      // (reload) must never consume the store meant for a pending sign-in.
      const target = oauthCallback
        ? consumeReturnUrl(currentReturnUrl())
        : null;
      if (target) goto(target, { replaceState: true });
      // Re-register this device's push subscription in case the browser
      // rotated the endpoint (Chrome/FCM does this periodically). No-op if
      // push is unsupported/unconfigured or permission was never granted.
      void subscribeIfAlreadyPermitted();
    }
  };

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const work = doInit();

  try {
    // Race init against the watchdog. Uses a plain `setTimeout` (not
    // `AbortSignal.timeout`) so it works even on older iOS Safari builds that
    // lack that API.
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              "Sign-in timed out — the authorization server didn't respond in time. " +
                "This can happen on iOS Safari after the OAuth callback. Tap Reload " +
                "below (or open Roomy in Safari) to try again.",
            ),
          );
        }, INIT_TIMEOUT_MS);
      }),
    ]);
    // `work` won: all session state was set inside `doInit`.
  } catch (err) {
    initError = String(err);

    // If the watchdog fired but the (slow) exchange actually completed in the
    // background afterwards, the session is now persisted and authenticated —
    // clear the error so the app reveals itself instead of a stuck overlay. A
    // manual reload would reach the same state via session restore, but this
    // avoids forcing the user to reload.
    if (timedOut) {
      work.then(
        () => {
          if (initError) {
            initError = null;
            initializing = false;
          }
        },
        () => {
          // Exchange failed after the timeout — error already surfaced above.
        },
      );
    }

    // If session restoration failed due to a recoverable ATProto auth error
    // (expired/revoked token, failed refresh), auto-reload to retry init —
    // this is the primary recovery path in the PWA where manual reload is
    // impossible. scheduleAutoReload no-ops for non-recoverable errors
    // (including this timeout), so genuine config/DNS/hang failures simply
    // surface as initError instead of causing reload loops.
    scheduleAutoReload(err);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    initializing = false;
  }
}

/**
 * The scope ceiling the ACTIVE OAuth client actually declares.
 *
 * Deployed web (HappyView) and Tauri desktop use a metadata-document URL as the
 * client id, whose declared scope is the full {@link FULL_SCOPE_CEILING}. The
 * dev loopback client embeds its scope in the client id instead, and that has
 * to stay short enough to fit the browser's 4096-byte Referer cap — so it is the
 * narrower {@link CLIENT_ID_SCOPE}.
 *
 * `login()` reconciles a stored grant against this, not unconditionally against
 * the full ceiling: reconciling against the full ceiling on the loopback client
 * re-requests tokens the client id does not declare, and the PDS rejects the
 * whole authorization with `invalid_scope`. The two conditions mirror
 * `createOAuthClient`'s choice (SDK): an explicit `clientId` or Tauri ⇒ a
 * metadata-document client id ⇒ full ceiling; otherwise the dev loopback client.
 */
function activeClientCeiling(): string {
  const tauri = typeof window !== "undefined" && "__TAURI__" in window;
  if (tauri || CONFIG.oauthClientId) return FULL_SCOPE_CEILING;
  return CLIENT_ID_SCOPE;
}

export async function login(handle: string) {
  currentHandle = handle;

  // Before kicking off OAuth, ask the appserver what scope this user last
  // consented to (unauthenticated `getLoginScope` — no token yet). A returning
  // user gets their previously-approved scope requested back, so the PDS
  // issues a full-access token with zero re-prompting. reconcileScope keeps
  // `base` always, drops anything the ACTIVE client's ceiling no longer
  // declares (which the PDS would reject with invalid_scope), and dedupes.
  let reconcile: string = SCOPE_SETS.base;
  try {
    const res = await (
      await pxUnauth()
    ).query("space.roomy.auth.getLoginScope", { handle });
    // decideLoginScope returns base for null/empty (fresh or unrecorded user)
    // and reconcileScope(stored, base, ceiling) for a stored grant.
    reconcile = decideLoginScope(res?.scope, activeClientCeiling());
  } catch (err) {
    // Failure is non-fatal: fall back to requesting base only. A stored-grant
    // lookup must never block a fresh login.
    console.warn("getLoginScope failed, requesting base scope:", err);
  }

  // Remember the page the user was on so `init()` can send them back here
  // after the PDS redirects to the fixed OAuth redirect URI (the homepage).
  // The OAuth `state` is the client's own CSRF token, never a transport for
  // this path (see `return-url.ts`).
  rememberReturnUrl(currentReturnUrl());
  const result = await sdkLogin(handle, {
    happyviewEndpoint: CONFIG.happyviewEndpoint,
    clientKey: CONFIG.happyviewClientKey,
    clientId: CONFIG.oauthClientId,
    port: CONFIG.port,
    handleResolverUrl: CONFIG.handleResolverUrl,
    scope: reconcile,
    clientIdScope: CLIENT_ID_SCOPE,
  });

  if (result) {
    // Tauri: sdkLogin resolves in place (no page navigation, so `init()`'s
    // navigation never runs). Wire up the session and go back to the store
    // directly.
    session = result.session;
    agent = result.agent;
    await setupDirectXrpc(result.agent);
    authenticated = true;
    // Same grant-tracking as init: introspect the granted scope (which may
    // have been narrowed on the consent screen) and sync it fire-and-forget.
    void trackGrant(result.session);
    const target = consumeReturnUrl(currentReturnUrl());
    if (target) goto(target, { replaceState: true });
  }
}

/** The sessionStorage key the pending scope-expansion tier is persisted under. */
const PENDING_EXPANSION_KEY = "pending-scope-expansion";

export function isScopeExpansionPending(): ScopeSetName | null {
  if (typeof sessionStorage === "undefined") return null;
  const pending = sessionStorage.getItem(PENDING_EXPANSION_KEY);
  return pending && pending in SCOPE_SETS ? (pending as ScopeSetName) : null;
}

/**
 * Ask the PDS to grant a wider scope tier and, on return, surface the result.
 *
 * The user asked to enable a capability (e.g. in the Phase 4 settings page).
 * This re-runs the OAuth flow with the wider tier's scope:
 *
 *   1. Record the desired tier in `sessionStorage` (survives the redirect —
 *      the browser navigates to the PDS and back, so in-memory state is lost).
 *   2. Record the intent on the appserver via `setScopeSettings`, then drive
 *      the PDS consent round-trip with the wider tier's scope.
 *   3. On return, `init()`'s `trackGrant` reads the actually-granted scope and
 *      fires `recordScopeGrant`; the settings page derives real state from
 *      the granted scope (whether the expansion took or was refused/narrowed).
 */
export async function requestScopeExpansion(
  tier: RequestableScopeSetName,
): Promise<void> {
  // App-password (test-mode) has no OAuth redirect to drive; the granted
  // scope is the requested tier already, so there is nothing to expand.
  if (appPasswordAgent) return;
  // The pending tier must survive the redirect; record it before navigating.
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(PENDING_EXPANSION_KEY, tier);
  }
  // Record intent appserver-side first (fire-and-forget; a failure must not
  // block the round-trip).
  await requestScopeSettings(tier);
  // Re-authorize as the account the live session belongs to. The handle typed
  // at login lives only in memory and is gone after the PDS redirect (the
  // callback lands in a new document), so the decision prefers the session DID
  // — which survives the reload — and only falls back to the in-memory handle.
  // `null` is a signed-out / sessionless caller: the intent is recorded above
  // and a future login will request it.
  const identity = decideScopeReauthIdentity({
    sessionDid: session?.did,
    handle: currentHandle,
  });
  if (!identity) {
    return;
  }
  // Drive the PDS consent round-trip with the WIDER tier's scope request —
  // not `login()`'s stored-grant reconcile, which would request the old
  // (unexpanded) scope. The PDS consent screen shows only the delta (the
  // tier's additions) for an already-granted base. On return `init()`'s
  // `trackGrant` records what the PDS actually granted.
  // Remember where the user was (the settings page) across the round-trip the
  // same way `login()` does; `init()` navigates back on the callback.
  rememberReturnUrl(currentReturnUrl());
  const ceiling = activeClientCeiling();
  const tierScope = SCOPE_SETS[tier];
  if (!scopeWithinCeiling(tierScope, ceiling)) {
    // The active client does not declare this tier — the loopback client id is
    // deliberately narrower than the full ceiling (it must fit the Referer
    // cap), so e.g. `withDms` cannot be requested from a dev loopback session.
    // Failing here keeps the error actionable instead of the PDS's opaque
    // `invalid_scope`. Deployed/HappyView builds declare the full ceiling, so
    // this is a dev-only guard.
    throw new Error(
      `The "${tier}" scope tier is not available in this build's OAuth client. ` +
        `It can only be requested where the client declares the full scope ` +
        `ceiling (a deployed web or desktop build), not the dev loopback client.`,
    );
  }
  const result = await sdkLogin(identity, {
    happyviewEndpoint: CONFIG.happyviewEndpoint,
    clientKey: CONFIG.happyviewClientKey,
    clientId: CONFIG.oauthClientId,
    handleResolverUrl: CONFIG.handleResolverUrl,
    port: CONFIG.port,
    scope: tierScope,
    clientIdScope: CLIENT_ID_SCOPE,
  });
  if (result) {
    // Tauri: sdkLogin resolves in-place (no page navigation), so `init()`'s
    // navigation never runs. Wire up the session like `login()` does and
    // return to the store directly; `init()`'s trackGrant path is not invoked
    // here, so record the grant directly.
    session = result.session;
    agent = result.agent;
    await setupDirectXrpc(result.agent);
    authenticated = true;
    void trackGrant(result.session);
    const target = consumeReturnUrl(currentReturnUrl());
    if (target) goto(target, { replaceState: true });
  }
}

/**
 * Record the user's requested scope tier on the appserver (Phase 4).
 *
 * `space.roomy.auth.setScopeSettings` cannot grant anything by itself —
 * granting needs the PDS consent round-trip. It records *intent*; the actual
 * stored grant updates only after `getTokenInfo()` confirms (via trackGrant →
 * `recordScopeGrant`). App-password (test) mode has no PDS grant and no
 * OAuth round-trip, so this is a no-op there.
 */
export async function requestScopeSettings(
  tier: RequestableScopeSetName,
): Promise<void> {
  if (appPasswordAgent) return; // no PDS grant to request in test mode
  try {
    await px().procedure("space.roomy.auth.setScopeSettings", {
      scope: SCOPE_SETS[tier],
    });
  } catch (err) {
    // Non-fatal: the client still drives the consent round-trip; a failed
    // intent record self-heals on the next login via getLoginScope.
    console.warn("Failed to record scope settings:", err);
  }
}

/**
 * Narrow the stored grant to `base` (revoke every extra tier).
 *
 * Recording the narrower scope via `recordScopeGrant` makes the next login
 * request less — no PDS round-trip because narrowing needs no consent. The
 * LIVE token keeps its scopes until the next re-auth; the UI must say so
 * rather than implying immediate revocation. App-password (test) mode has no
 * real grant to narrow.
 */
export async function revokeScopeSettings(): Promise<void> {
  if (appPasswordAgent) return; // no PDS grant in test mode
  try {
    // Record the intent (clears any pending expansion) …
    await requestScopeSettings("base");
    // … and narrow the stored grant so a future login requests only base.
    await px().procedure("space.roomy.auth.recordScopeGrant", {
      scope: SCOPE_SETS.base,
    });
  } catch (err) {
    console.warn("Failed to revoke scope settings:", err);
  }
}

/**
 * Fetch the user's Roomy profile from the appserver and update the reactive
 * `auth.profile` state + the persisted last-login record. Call this
 * immediately on login/init.
 *
 * Uses the appserver's `space.roomy.user.getProfile` XRPC (Roomy-first with
 * Bluesky fallback) instead of calling the Bluesky appview directly. This
 * keeps the profile source consistent: the appserver materializes the
 * `space.roomy.user.profile/self` PDS record, falling back to the Bluesky
 * appview when no Roomy record exists.
 */
export async function updateProfile() {
  const did = session?.did ?? agent?.did;
  if (!did) return;
  try {
    const res = await px().query("space.roomy.user.getProfile", { actor: did });
    const p = {
      handle: res.handle ?? "",
      did,
      avatar: res.avatar ?? "",
      displayName: res.displayName || undefined,
    };
    profile = p;
    saveLastLogin(p);
  } catch (e) {
    // The reactive `profile` drives the signed-in UI, so a failed fetch means
    // no profile for this session — but the "Previously signed in as" record
    // is the *signed-out* affordance and is only ever written on success, so
    // it is deliberately left alone here: it is verified against its DID
    // before being offered (see `last-login.svelte.ts`).
    console.warn("Failed to fetch profile:", e);
  }
}

/**
 * End the session and return to the login path, by reloading into a document
 * that has no session to restore.
 *
 * The local state is cleared unconditionally, ahead of the reload, so a step
 * that fails cannot leave the app rendering the previous account.
 */
export async function logout() {
  // Every step below is best-effort: a session that is already dead — the case
  // that reaches here from the error-recovery hand-off — is exactly one whose
  // sign-out can reject (the HappyView client, for one, revokes over the same
  // network it just failed on). None of it may leave the app authenticated and
  // stuck, so each step is guarded and the local state is cleared regardless.
  try {
    // The cache store is per-origin, not per-account, and this reloads the page
    // without a fresh session — so the snapshot must go first or the next
    // account's first load restores the previous account's rooms. Best-effort:
    // the account-scope check on load is the second line of defence.
    await clearPersistedCache();
  } catch (err) {
    console.warn("[logout] clearing the persisted cache failed:", err);
  }
  try {
    // Stop delivering push to this device while signed out. clearPushSubscription
    // returns an outcome (never throws) — just log on non-ok.
    const pushOutcome = await clearPushSubscription();
    if (pushOutcome.status !== "ok" && pushOutcome.status !== "unsupported") {
      console.warn("[push] clear on logout failed:", pushOutcome.status);
    }
  } catch (err) {
    console.warn("[push] clear on logout threw:", err);
  }
  try {
    if (appPasswordAgent) {
      await appPasswordAgent.logout();
    } else if (session) {
      await sdkLogout(session);
    }
  } catch (err) {
    console.warn("[logout] revoking the session failed:", err);
  }
  serviceAuth?.clear();
  serviceAuth = null;
  directXrpc = null;
  authenticated = false;
  agent = null;
  session = null;
  appPasswordAgent = null;
  grantedScope = null;
  profile = null;
  location.reload();
}

/**
 * Get the XRPC client for making typed calls to the appserver.
 *
 * Makes direct HTTP requests to the appserver using short-lived service
 * auth tokens obtained from `com.atproto.server.getServiceAuth`. Token
 * caching and auto-refresh are handled transparently.
 *
 * Throws if the user is not authenticated.
 */
export function px(): InstanceType<typeof DirectXrpcClient> {
  if (!directXrpc) throw new Error("Not authenticated");
  return directXrpc;
}