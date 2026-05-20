import { Agent } from "@atproto/api";
import {
  initSession,
  login as sdkLogin,
  logout as sdkLogout,
  makeProxiedAgent,
  saveAppserverDid,
  type OAuthSession,
} from "@roomy-space/sdk/browser";
import { CONFIG, OAUTH_SCOPE } from "./config";

let agent = $state<Agent | null>(null);
let session = $state<OAuthSession | null>(null);
let authenticated = $state(false);
let initError = $state<string | null>(null);

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
  get initError() {
    return initError;
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
      authenticated = true;
    }
  } catch (err) {
    initError = String(err);
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

export async function logout() {
  if (session) await sdkLogout(session);
  authenticated = false;
  agent = null;
  session = null;
  location.reload();
}

/** Proxied agent for XRPC calls via PDS → appserver. */
export function px(): Agent {
  if (!agent) throw new Error("Not authenticated");
  return makeProxiedAgent(agent, CONFIG.appserverDid);
}
