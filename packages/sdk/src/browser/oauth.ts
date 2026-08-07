/**
 * Browser OAuth lifecycle for Roomy apps.
 *
 * This is the **only** module in `@roomy/sdk` that imports
 * `@atproto/oauth-client-browser` and `sessionStorage`. The core SDK
 * never imports it; the `/browser` subpath export ensures appserver
 * builds don't pull it in transitively.
 *
 * @module @roomy/sdk/browser
 */

import {
  BrowserOAuthClient,
  atprotoLoopbackClientMetadata,
  buildLoopbackClientId,
} from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";
import type { OAuthSession } from "@atproto/oauth-client-browser";

// Declares necessary parts of tauri JS API exposed through `window.__TAURI__`. 
// (available when `withGlobalTauri` is enabled in config.tauri.json)
// without a dependency on @tauri-apps/api
// Tauri apps gate access on the runtime check `'__TAURI__' in window`.
declare global {
  interface Window {
    __TAURI__?: {
      opener: {
        openUrl(url: string | URL): Promise<void>;
      };
      deepLink: {
        onOpenUrl(handler: (urls: string[]) => void): Promise<() => void>;
      };
      http: {
        fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
      }
    };
  }
}

// ── Config ────────────────────────────────────────────────────────────────

const HANDLE_RESOLVER = "https://bsky.social";

export const DEFAULT_APPSERVER_DID = "did:web:appserver.roomy.chat";

// ── Lexicon definitions (for atproto agent proxy) ─────────────────────────
//
// Generated lexicons live in ../schemas/lexicons/*.json and are auto-generated
// from the arktype schemas by `pnpm generate:lexicons`. Admin-only NSIDs
// that have no arktype schema are defined inline below.

import lexGetConnectionTicket from "../schemas/lexicons/space.roomy.auth.getConnectionTicket.json";
import lexGetMessage from "../schemas/lexicons/space.roomy.message.getMessage.json";
import lexGetMessages from "../schemas/lexicons/space.roomy.room.getMessages.json";
import lexGetRoomMetadata from "../schemas/lexicons/space.roomy.room.getMetadata.json";
import lexGetRoomThreads from "../schemas/lexicons/space.roomy.room.getThreads.json";
import lexUpdateSeen from "../schemas/lexicons/space.roomy.room.updateSeen.json";
import lexCreateSpace from "../schemas/lexicons/space.roomy.space.createSpace.json";
import lexGetInvites from "../schemas/lexicons/space.roomy.space.getInvites.json";
import lexGetMembers from "../schemas/lexicons/space.roomy.space.getMembers.json";
import lexGetSpaceMetadata from "../schemas/lexicons/space.roomy.space.getMetadata.json";
import lexGetRoles from "../schemas/lexicons/space.roomy.space.getRoles.json";
import lexGetSpaces from "../schemas/lexicons/space.roomy.space.getSpaces.json";
import lexGetActivityFeed from "../schemas/lexicons/space.roomy.space.getActivityFeed.json";
import lexGetSpaceThreads from "../schemas/lexicons/space.roomy.space.getThreads.json";
import lexJoinSpace from "../schemas/lexicons/space.roomy.space.joinSpace.json";
import lexLeaveSpace from "../schemas/lexicons/space.roomy.space.leaveSpace.json";
import lexSendEvents from "../schemas/lexicons/space.roomy.space.sendEvents.json";
import lexGetVapidPublicKey from "../schemas/lexicons/space.roomy.push.getVapidPublicKey.json";
import lexRegisterSubscription from "../schemas/lexicons/space.roomy.push.registerSubscription.json";
import lexUnregisterSubscription from "../schemas/lexicons/space.roomy.push.unregisterSubscription.json";
import lexGetPreferences from "../schemas/lexicons/space.roomy.push.getPreferences.json";
import lexSetPreferences from "../schemas/lexicons/space.roomy.push.setPreferences.json";
import lexGetFlags from "../schemas/lexicons/space.roomy.getFlags.json";
/** Admin/internal NSIDs that have no arktype schema (so no generated lexicon). */
const ADMIN_LEXICONS = [
  {
    lexicon: 1,
    id: "space.roomy.admin.connectSpace",
    defs: {
      main: {
        type: "query" as const,
        parameters: {
          type: "params" as const,
          required: ["did"],
          properties: { did: { type: "string" as const } },
        },
        output: {
          encoding: "application/json",
          schema: { type: "object" as const },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: "space.roomy.admin.materializeSpace",
    defs: {
      main: {
        type: "query" as const,
        parameters: {
          type: "params" as const,
          required: ["did"],
          properties: {
            did: { type: "string" as const },
            wait: { type: "string" as const },
          },
        },
        output: {
          encoding: "application/json",
          schema: { type: "object" as const },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: "space.roomy.admin.getFlags",
    defs: {
      main: {
        type: "query" as const,
        output: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["flags"],
            properties: {
              flags: {
                type: "array" as const,
                items: {
                  type: "object" as const,
                  required: ["key", "description", "globalEnabled", "assignedDids"],
                  properties: {
                    key: { type: "string" as const },
                    description: { type: "string" as const },
                    globalEnabled: { type: "boolean" as const },
                    assignedDids: {
                      type: "array" as const,
                      items: { type: "string" as const },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: "space.roomy.admin.setFlag",
    defs: {
      main: {
        type: "procedure" as const,
        input: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            properties: {
              flag: { type: "string" as const },
              all: { type: "boolean" as const },
              userDids: {
                type: "array" as const,
                items: { type: "string" as const },
              },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: "space.roomy.admin.clearFlag",
    defs: {
      main: {
        type: "procedure" as const,
        input: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["flag"],
            properties: {
              flag: { type: "string" as const },
            },
          },
        },
      },
    },
  },
];

/** All Roomy lexicons, used by `makeProxiedAgent` to register on the atproto Agent. */
const LEXICONS = [
  lexGetConnectionTicket,
  lexGetMessage,
  lexGetMessages,
  lexGetRoomMetadata,
  lexGetRoomThreads,
  lexUpdateSeen,
  lexCreateSpace,
  lexGetInvites,
  lexGetMembers,
  lexGetSpaceMetadata,
  lexGetRoles,
  lexGetSpaces,
  lexGetActivityFeed,
  lexGetSpaceThreads,
  lexJoinSpace,
  lexLeaveSpace,
  lexSendEvents,
  lexGetVapidPublicKey,
  lexGetFlags,
  lexRegisterSubscription,
  lexUnregisterSubscription,
  lexGetPreferences,
  lexSetPreferences,
  ...ADMIN_LEXICONS,
];

// ── OAuth client setup ────────────────────────────────────────────────────

function buildScope(_appserverDid: string) {
  return "atproto transition:generic";
}

export interface CreateOAuthClientOptions {
  /** The port the local app listens on (for the loopback redirect URI). */
  port?: number;
  /**
   * OAuth scope string. If omitted, defaults to `atproto transition:generic`.
   * Callers that need explicit `rpc:` scopes (e.g. app-lite) pass them here.
   */
  scope?: string;
  /**
   * If true, fetch client metadata from `/oauth-client-metadata.json` instead
   * of building a loopback client. Used in production deployments.
   */
  usePublicClient?: boolean;
}

export async function createOAuthClient(
  appserverDid: string,
  opts: CreateOAuthClientOptions = {},
): Promise<BrowserOAuthClient> {
  const scope = opts.scope ?? buildScope(appserverDid);

  const tauri = window.__TAURI__
  // Production: fetch public client metadata deployed alongside the static build
  if (opts.usePublicClient) {
    const resp = await fetch("/oauth-client-metadata.json", {
      headers: [["accept", "application/json"]],
    });
    const clientMetadata = await resp.json();
    return new BrowserOAuthClient({
      clientMetadata,
      handleResolver: HANDLE_RESOLVER,
      responseMode: "query",
    });
  } else if (tauri) {
    const req = await tauri.http.fetch("https://roomy.space/oauth-client-native.json")
    const clientMetadata = await req.json()
    return new BrowserOAuthClient({
      clientMetadata,
      handleResolver: HANDLE_RESOLVER,
      responseMode: "query",
    });
  }

  // Development: loopback client
  const port = opts.port ?? 5199;
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  baseUrl.hash = "";
  baseUrl.pathname = "/";
  const redirectUri = baseUrl.href;

  const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;

  return new BrowserOAuthClient({
    clientMetadata: {
      ...atprotoLoopbackClientMetadata(buildLoopbackClientId(baseUrl)),
      redirect_uris: [redirectUri],
      scope,
      client_id: clientId,
    },
    handleResolver: HANDLE_RESOLVER,
  });
}

// ── Proxied agent ─────────────────────────────────────────────────────────

/**
 * Create an atproto Agent configured to proxy XRPC calls through the
 * given appserver DID. Registers all known Roomy lexicons so the agent
 * knows how to serialize/deserialize them.
 */
export function makeProxiedAgent(agent: Agent, appserverDid: string): Agent {
  const proxied = agent.clone();
  proxied.configureProxy(
    `${appserverDid}#space_roomy_appserver` as unknown as Parameters<
      Agent["configureProxy"]
    >[0],
  );
  for (const lex of LEXICONS) proxied.lex.add(lex as any);
  return proxied;
}

// ── Appserver DID persistence ─────────────────────────────────────────────

const APPSERVER_DID_KEY = "appserver-did";

export function saveAppserverDid(did: string): void {
  sessionStorage.setItem(APPSERVER_DID_KEY, did);
}

export function loadAppserverDid(): string {
  return sessionStorage.getItem(APPSERVER_DID_KEY) || DEFAULT_APPSERVER_DID;
}

// ── Session lifecycle ─────────────────────────────────────────────────────

export interface InitSessionOptions {
  port?: number;
  scope?: string;
  usePublicClient?: boolean;
  /**
   * Opaque string carried through the OAuth round-trip via the `state`
   * parameter. Returned verbatim by `initSession()` once the callback is
   * processed. Apps use this to remember the URL the user was on before
   * signing in and redirect back to it after the PDS callback.
   */
  state?: string;
  /**
   * How long the login flow should stay pending before `login()`
   * aborts (user abandoned auth). Defaults to 10 minutes,
   */
  loginTimeoutMs?: number;
}

/**
 * Try to restore an existing OAuth session (e.g. after a page reload or
 * redirect back from the PDS). Returns `{ session, agent, state }` if a
 * session was found, or `null` if the user is not authenticated. `state`
 * is the OAuth `state` value round-tripped through the PDS (present only
 * when this call processed an OAuth callback, not a plain session restore).
 */
export type LoginResult = { session: OAuthSession; agent: Agent; state?: string | null; }

export async function initSession(
  appserverDid: string,
  opts: InitSessionOptions = {},
): Promise<LoginResult | null> {
  const client = await createOAuthClient(appserverDid, opts);
  let result: {
    session: OAuthSession;
    state?: never;
  } | {
    session: OAuthSession;
    state: string | null;
  } | undefined

  // Tauri / native custom-scheme callbacks can't be auto-detected by `client.init()`:
  // `findRedirectUrl()` compares HTTP origins against the
  // registered redirect URIs, and a `space.roomy:/…` scheme never matches the
  // webview origin (`tauri://localhost`). 
  if ('__TAURI__' in window) {
    const params = new URLSearchParams(location.search);
    if (params.has('state') && (params.has('code') || params.has('error'))) {
      result = await client.initCallback(params, client.clientMetadata.redirect_uris[0]);
    }
  } else {
    result = await client.init();
  }

  if (result?.session) {
    return {
      session: result.session,
      agent: new Agent(result.session as any),
      // `state` is only present when `init()` processed an OAuth callback
      // (URL contained callback params). On a plain session restore it is
      // `undefined`, so callers can distinguish the two cases.
      state: result.state,
    };
  }
  return null;
}

/**
 * Initiate an OAuth sign-in flow.
 *
 * Web: redirects the browser to the PDS authorization page; the promise does
 * **not** resolve in the current page context (the browser navigates away)
 * and the returned value is never reached.
 *
 * Tauri: opens the PDS in the system browser, then **blocks** until the
 * deep-link redirect (`space.roomy:/?state=…&code=…`) arrives and processes
 * the callback in place. Returns `LoginResult` on success and throws on error/denial
 */
export async function login(
  appserverDid: string,
  handle: string,
  opts: InitSessionOptions = {},
): Promise<void | LoginResult> {
  const client = await createOAuthClient(appserverDid, opts);

  const tauri = window.__TAURI__;
  if (tauri) {
    // opener IPC promise or the deep-link listener could in theory never settle.
    // Race the whole Tauri flow against a timeout so an abandoned login ALWAYS resolves,
    // letting the caller revert its loading state and surface the expiry. 
    const timeoutMs = opts.loginTimeoutMs ?? 10 * 60_000;
    return await Promise.race([
      tauriLogin(client, handle, opts, tauri),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Auth request has expired')), timeoutMs)),
    ])
  }

  // Forward `state` so the app can round-trip a return URL through the PDS.
  // The value comes back unchanged via `initSession()`'s `state` field.
  await client.signIn(handle, opts.state ? { state: opts.state } : undefined);
}

async function tauriLogin(
  client: BrowserOAuthClient,
  handle: string,
  opts: InitSessionOptions,
  tauri: NonNullable<Window["__TAURI__"]>,
): Promise<LoginResult> {
  const url = await client.authorize(handle, opts.state ? { state: opts.state } : undefined);

  // Fire-and-forget. Promise may never settle on some platforms
  tauri.opener.openUrl(url);


  // Wait for the next deep-link event targeting this app. Resolves with the
  // first URL (e.g. `space.roomy:/?state=…&code=…`) or `null` on timeout.
  // The listener is removed on the first event (or after the timeout)
  const deepUrl = await new Promise<string>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    tauri.deepLink
      .onOpenUrl((urls) => {
        unlisten?.();
        const url = urls[0]
        if (!url) {
          reject(new Error('Error while opening url'))
          return
        }
        resolve(url)
      })
      .then((unlistenFn) => {
        unlisten = unlistenFn;
      })
      .catch(reject)
  });

  // initCallback throws on error in query params 
  const params = new URLSearchParams(new URL(deepUrl).search);
  const result = await client.initCallback(params, client.clientMetadata.redirect_uris[0]);
  if (result.session) return {
    session: result.session,
    agent: new Agent(result.session as any),
    state: result.state,
  };
  throw new Error('Invalid session result')
}

/**
 * Sign out and clear all stored session state.
 */
export async function logout(session: OAuthSession): Promise<void> {
  await session.signOut();
  sessionStorage.clear();
}
