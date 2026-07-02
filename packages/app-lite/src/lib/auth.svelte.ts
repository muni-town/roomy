import { Agent } from "@atproto/api";
import {
  initSession,
  login as sdkLogin,
  logout as sdkLogout,
  saveAppserverDid,
  type OAuthSession,
} from "@roomy-space/sdk/browser";
import { transport } from "@roomy-space/sdk";
import { goto } from "$app/navigation";
import { CONFIG, OAUTH_SCOPE } from "./config";
import { scheduleAutoReload } from "./error-recovery";
import { setAppserverOrigin } from "./appserver-origin";
import { subscribeIfAlreadyPermitted, clearPushSubscription } from "./push.svelte";

const { ServiceAuthClient, DirectXrpcClient, resolveAppserverHttpOrigin } = transport;

let agent = $state<Agent | null>(null);
let session = $state<OAuthSession | null>(null);
let authenticated = $state(false);
let initializing = $state(true);
let initError = $state<string | null>(null);

/** Cached profile for the current session, set reactively after login. */
let profile = $state<{ handle: string; did: string; avatar: string; displayName?: string } | null>(null);

// Direct XRPC client (replaces the proxied agent pattern).
// Created lazily once the agent is available.
let serviceAuth: InstanceType<typeof ServiceAuthClient> | null = null;
let directXrpc: InstanceType<typeof DirectXrpcClient> | null = null;

export const auth = {
  get agent() {
    return agent;
  },
  get session() {
    return session;
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

export async function init() {
  try {
    saveAppserverDid(CONFIG.appserverDid);
    const result = await initSession(CONFIG.appserverDid, {
      port: CONFIG.port,
      scope: OAUTH_SCOPE,
      usePublicClient: CONFIG.usePublicClient,
    });
    if (result) {
      session = result.session;
      agent = result.agent;

      // Set up direct XRPC transport with service auth
      serviceAuth = new ServiceAuthClient(result.agent);
      const appserverUrl = await resolveAppserverHttpOrigin(CONFIG.appserverDid);
      setAppserverOrigin(appserverUrl);
      directXrpc = new DirectXrpcClient(
        appserverUrl,
        CONFIG.appserverDid,
        serviceAuth,
      );

      authenticated = true;

      // After an OAuth callback the browser lands on the fixed redirect URI
      // (the homepage). If we round-tripped the original URL through the
      // `state` parameter in `login()`, navigate back to it now. On a plain
      // session restore (reload) `result.state` is undefined, so we stay put.
      const returnUrl = safeReturnUrl(result.state);
      if (returnUrl && returnUrl !== currentReturnUrl()) {
        goto(returnUrl, { replaceState: true });
      }
      // Re-subscribe this device for web push, but only if the user has
      // already granted notification permission — never prompt at login
      // (no user gesture here, and Safari blocks non-gesture prompts). The
      // settings page's "Enable notifications" button is the prompt trigger.
      // Fire-and-forget: it must never block session restoration.
      void subscribeIfAlreadyPermitted();
    }
  } catch (err) {
    initError = String(err);
    // If session restoration failed due to a recoverable ATProto auth error
    // (expired/revoked token, failed refresh), auto-reload to retry init —
    // this is the primary recovery path in the PWA where manual reload is
    // impossible. scheduleAutoReload no-ops for non-recoverable errors, so
    // genuine config/DNS failures simply surface as initError instead.
    scheduleAutoReload(err);
  } finally {
    initializing = false;
  }
}

export async function login(handle: string) {
  saveAppserverDid(CONFIG.appserverDid);
  // Remember the page the user was on so `init()` can send them back here
  // after the PDS redirects to the fixed OAuth redirect URI (the homepage).
  const returnUrl = currentReturnUrl();
  await sdkLogin(CONFIG.appserverDid, handle, {
    port: CONFIG.port,
    scope: OAUTH_SCOPE,
    usePublicClient: CONFIG.usePublicClient,
    state: returnUrl,
  });
}

/**
 * Fetch the user's AT Protocol profile and update the reactive `auth.profile`
 * state + localStorage cache. Call this immediately on login/init.
 */
export async function updateProfile() {
  if (!agent || !session) return;
  try {
    const res = await agent.app.bsky.actor.getProfile({ actor: session.did });
    const p = {
      handle: res.data.handle,
      did: session.did,
      avatar: res.data.avatar ?? "",
      displayName: res.data.displayName || undefined,
    };
    profile = p;
    localStorage.setItem("last-login", JSON.stringify(p));
  } catch (e) {
    console.warn("Failed to fetch profile:", e);
  }
}

export async function logout() {
  // Stop delivering push to this device while signed out. Best-effort: a
  // failure here must not block logout. clearPushSubscription returns an
  // outcome (never throws) — just log on non-ok.
  const outcome = await clearPushSubscription();
  if (outcome.status !== "ok" && outcome.status !== "unsupported") {
    console.warn("[push] clear on logout failed:", outcome.status);
  }
  if (session) await sdkLogout(session);
  serviceAuth?.clear();
  serviceAuth = null;
  directXrpc = null;
  authenticated = false;
  agent = null;
  session = null;
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
