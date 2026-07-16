import { Agent } from "@atproto/api";
import {
  initSession,
  login as sdkLogin,
  logout as sdkLogout,
  saveAppserverDid,
  loadAppserverDid,
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
};

export async function init() {
  initializing = true;
  initError = null;
  authError = null;

  try {
    const appserverDid = loadAppserverDid();
    const res = await initSession(appserverDid, {
      port: CONFIG.port,
      usePublicClient: CONFIG.usePublicClient,
    });
    if (res) {
      const did = res.session.did;
      if (ADMIN_DIDS.has(did)) {
        session = res.session;
        agent = res.agent;
        authenticated = true;
      } else {
        authError = `DID ${did} is not on the admin allowlist`;
        await sdkLogout(res.session);
      }
    }
  } catch (err) {
    initError = String(err);
  } finally {
    initializing = false;
  }
}

export async function login(handle: string) {
  authError = null;
  const appserverDid = loadAppserverDid();
  saveAppserverDid(appserverDid);
  await sdkLogin(appserverDid, handle, {
    port: CONFIG.port,
    usePublicClient: CONFIG.usePublicClient,
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
