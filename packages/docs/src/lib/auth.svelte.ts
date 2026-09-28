import { Agent } from "@atproto/api";
import {
  initSession,
  login as sdkLogin,
  logout as sdkLogout,
} from "@roomy-space/sdk/browser";
import type { OAuthSession } from "@roomy-space/sdk/browser";
import { ADMIN_DIDS, CONFIG } from "./config";

let agent = $state<Agent | null>(null);
let session = $state<OAuthSession | null>(null);
let authenticated = $state(false);
let initializing = $state(true);
let initError = $state<string | null>(null);
let authError = $state<string | null>(null);

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
  get initializing() {
    return initializing;
  },
  get initError() {
    return initError;
  },
  get authError() {
    return authError;
  },
  /**
   * Whether the signed-in DID is on the docs site's admin allowlist
   * (PUBLIC_APPSERVER_ADMIN_DIDS). UI-only: it drives nav visibility and
   * badges, never a security boundary. The appserver enforces real
   * authorization via its own APPSERVER_ADMIN_DIDS allowlist.
   */
  get isAdmin() {
    return authenticated && session !== null && ADMIN_DIDS.has(session.did);
  },
};

export async function init() {
  initializing = true;
  initError = null;
  authError = null;

  try {
    const res = await initSession({
      happyviewEndpoint: CONFIG.happyviewEndpoint,
      clientKey: CONFIG.happyviewClientKey,
      clientId: CONFIG.oauthClientId,
      handleResolverUrl: CONFIG.handleResolverUrl,
      port: CONFIG.port,
    });
    if (res) {
      // Anyone with a valid ATProto identity can use the docs site. Admin
      // endpoints simply 403 for non-admins (enforced by the appserver).
      session = res.session;
      agent = res.agent;
      authenticated = true;
    }
  } catch (err) {
    initError = String(err);
  } finally {
    initializing = false;
  }
}

export async function login(handle: string) {
  authError = null;
  await sdkLogin(handle, {
    happyviewEndpoint: CONFIG.happyviewEndpoint,
    clientKey: CONFIG.happyviewClientKey,
    clientId: CONFIG.oauthClientId,
    port: CONFIG.port,
    handleResolverUrl: CONFIG.handleResolverUrl,
  });
}

export async function logout() {
  if (session) {
    await sdkLogout(session);
  }
  authenticated = false;
  agent = null;
  session = null;
  location.reload();
}
