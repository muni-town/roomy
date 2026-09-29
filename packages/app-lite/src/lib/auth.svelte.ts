import { Agent, AtpAgent } from "@atproto/api";
import {
  initSession,
  login as sdkLogin,
  logout as sdkLogout,
  saveAppserverDid,
  type OAuthSession,
} from "@roomy-space/sdk/browser";
import { transport } from "@roomy-space/sdk";
import { goto } from "$app/navigation";
import { CONFIG } from "./config";
import { SCOPE_SETS, hasScopeSet } from "./scopes";
import { APP_PASSWORD_GRANTED_SCOPE, decideLoginScope } from "./scope-grant";
import { scheduleAutoReload } from "./error-recovery";
import { pxUnauth } from "./client";
import { setAppserverOrigin } from "./appserver-origin";
import { subscribeIfAlreadyPermitted, clearPushSubscription } from "./push.svelte";
import { saveLastLogin } from "./last-login.svelte";

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

/**
 * The current page location (path + query + hash), suitable for round-tripping
 * through the OAuth `state` parameter so we can send the user back where they
 * were after the PDS callback.
 */
function currentReturnUrl(): string {
  return location.pathname + location.search + location.hash;
}

/**
 * Validate a value returned from the OAuth `state` parameter before treating
 * it as a navigation target. `state` is opaque to the PDS and returned verbatim,
 * so under normal flow it is exactly what we sent in `login()`. But a crafted
 * callback URL could inject an arbitrary `state`, so only accept same-origin,
 * path-relative targets (must start with a single `/`). This prevents an
 * open-redirect via a malicious `state` like `https://evil.example` or
 * `//evil.example`.
 */
function safeReturnUrl(state: unknown): string | null {
  if (typeof state !== "string" || state.length === 0) return null;
  // Must be a root-relative path; reject protocol-relative (`//`) and absolute URLs.
  if (state[0] !== "/" || state[1] === "/") return null;
  return state;
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
    saveAppserverDid(CONFIG.appserverDid);

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

    const result = await initSession(CONFIG.appserverDid, {
      port: CONFIG.port,
      scope: SCOPE_SETS.base,
      usePublicClient: CONFIG.usePublicClient,
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

      // After an OAuth callback the browser lands on the fixed redirect URI
      // (the homepage). If we round-tripped the original URL through the
      // `state` parameter in `login()`, navigate back to it now. On a plain
      // session restore (reload) `result.state` is undefined, so we stay put.
      const returnUrl = safeReturnUrl(result.state);
      if (returnUrl && returnUrl !== currentReturnUrl()) {
        goto(returnUrl, { replaceState: true });
      }
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

export async function login(handle: string) {
  saveAppserverDid(CONFIG.appserverDid);

  // Before kicking off OAuth, ask the appserver what scope this user last
  // consented to (unauthenticated `getLoginScope` — no token yet). A returning
  // user gets their previously-approved scope requested back, so the PDS
  // issues a full-access token with zero re-prompting. reconcileScope keeps
  // `base` always, drops anything the current ceiling no longer declares
  // (which the PDS would reject with invalid_scope), and dedupes.
  let reconcile: string = SCOPE_SETS.base;
  try {
    const res = await (
      await pxUnauth()
    ).query("space.roomy.auth.getLoginScope", { handle });
    // decideLoginScope returns base for null/empty (fresh or unrecorded user)
    // and reconcileScope(stored) for a stored grant.
    reconcile = decideLoginScope(res?.scope);
  } catch (err) {
    // Failure is non-fatal: fall back to requesting base only. A stored-grant
    // lookup must never block a fresh login.
    console.warn("getLoginScope failed, requesting base scope:", err);
  }

  // Remember the page the user was on so `init()` can send them back here
  // after the PDS redirects to the fixed OAuth redirect URI (the homepage).
  const returnUrl = currentReturnUrl();
  const result = await sdkLogin(CONFIG.appserverDid, handle, {
    port: CONFIG.port,
    scope: reconcile,
    usePublicClient: CONFIG.usePublicClient,
    state: returnUrl,
  });

  if (result) {
    session = result.session;
    agent = result.agent;
    await setupDirectXrpc(result.agent);
    authenticated = true;
    // Same grant-tracking as init: introspect the granted scope (which may
    // have been narrowed on the consent screen) and sync it fire-and-forget.
    void trackGrant(result.session);
    const target = safeReturnUrl(result.state) ?? returnUrl;
    if (target && target !== currentReturnUrl()) {
      goto(target, { replaceState: true });
    }
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

export async function logout() {
  // Stop delivering push to this device while signed out. Best-effort: a
  // failure here must not block logout. clearPushSubscription returns an
  // outcome (never throws) — just log on non-ok.
  const pushOutcome = await clearPushSubscription();
  if (pushOutcome.status !== "ok" && pushOutcome.status !== "unsupported") {
    console.warn("[push] clear on logout failed:", pushOutcome.status);
  }
  if (appPasswordAgent) {
    await appPasswordAgent.logout();
  } else if (session) {
    await sdkLogout(session);
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