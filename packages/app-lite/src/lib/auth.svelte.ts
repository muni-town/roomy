import { Agent } from "@atproto/api";
import {
  initSession,
  login as sdkLogin,
  logout as sdkLogout,
  saveAppserverDid,
  type OAuthSession,
} from "@roomy-space/sdk/browser";
import { transport } from "@roomy-space/sdk";
import { CONFIG, OAUTH_SCOPE } from "./config";

const { ServiceAuthClient, DirectXrpcClient, resolveAppserverHttpOrigin } = transport;

let agent = $state<Agent | null>(null);
let session = $state<OAuthSession | null>(null);
let authenticated = $state(false);
let initializing = $state(true);
let initError = $state<string | null>(null);

/** Cached profile for the current session, set reactively after login. */
let profile = $state<{ handle: string; did: string; avatar: string } | null>(null);

// Direct XRPC client (replaces the proxied agent pattern).
// Created lazily once the agent is available.
let serviceAuth: ServiceAuthClient | null = null;
let directXrpc: DirectXrpcClient | null = null;

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
      directXrpc = new DirectXrpcClient(
        appserverUrl,
        CONFIG.appserverDid,
        serviceAuth,
      );

      authenticated = true;
    }
  } catch (err) {
    initError = String(err);
  } finally {
    initializing = false;
  }
}

export async function login(handle: string) {
  saveAppserverDid(CONFIG.appserverDid);
  await sdkLogin(CONFIG.appserverDid, handle, {
    port: CONFIG.port,
    scope: OAUTH_SCOPE,
    usePublicClient: CONFIG.usePublicClient,
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
    };
    profile = p;
    localStorage.setItem("last-login", JSON.stringify(p));
  } catch (e) {
    console.warn("Failed to fetch profile:", e);
  }
}

export async function logout() {
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
export function px(): DirectXrpcClient {
  if (!directXrpc) throw new Error("Not authenticated");
  return directXrpc;
}
