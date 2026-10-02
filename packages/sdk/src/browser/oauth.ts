/**
 * Browser OAuth lifecycle for Roomy apps.
 *
 * Two modes, selected by configuration:
 *
 * 1. **HappyView-held session** (when `VITE_HAPPYVIEW_ENDPOINT` +
 *    `VITE_HAPPYVIEW_CLIENT_KEY` are configured — together or not at all;
 *    web only): the user's ATProto session
 *    is held BY the HappyView instance, not by the web client. The browser
 *    only keeps a HappyView DPoP session (access token + shared key), while
 *    the PDS tokens — including the refresh token — are registered
 *    server-side at HappyView (`POST /oauth/sessions`) and stored encrypted
 *    there. HappyView refreshes its copy server-side and proxies standard
 *    atproto methods (reads and writes) to the user's PDS, so the browser
 *    never talks to the PDS directly again. When the app's OAuth client
 *    metadata publishes `jwks_uri` +
 *    `token_endpoint_auth_method: "private_key_jwt"` (see
 *    `packages/app-lite/scripts/build-prod.sh`), HappyView authenticates to
 *    the user's PDS as a *confidential* client on Roomy's behalf — PDSes
 *    grant confidential clients far longer refresh-token lifetimes (~2 years
 *    vs ~2 weeks on a conforming PDS), which is the point of this mode.
 *
 * 2. **Legacy direct-PDS session** (fallback when HappyView is not
 *    configured; always in Tauri desktop): the pre-HappyView behavior — a
 *    `@atproto/oauth-client-browser`
 *    public client. Dev uses a loopback client id; deployed builds use the
 *    served metadata (`usePublicClient`); Tauri uses the native metadata +
 *    deep-link redirect. Tokens live in the browser.
 *
 * This is the **only** module in `@roomy/sdk` that imports
 * `@happyview/oauth-client-browser`, `@atproto/oauth-client-browser`, and
 * touches `sessionStorage`/`localStorage` persistence. The core SDK never
 * imports it; the `/browser` subpath export ensures appserver builds don't
 * pull it in transitively.
 */

import { Agent } from "@atproto/api";
import {
  BrowserOAuthClient,
  atprotoLoopbackClientMetadata,
  buildLoopbackClientId,
} from "@atproto/oauth-client-browser";
import type { OAuthSession as AtprotoOAuthSession } from "@atproto/oauth-client-browser";
import { HappyViewBrowserClient } from "@happyview/oauth-client-browser";
import type { HappyViewSession } from "@happyview/oauth-client-browser";
import { authorizeRequestOptions } from "./oauth-options";

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
        fetch(
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response>;
      };
      app: {
        getVersion(): Promise<string>;
      };
      process: {
        relaunch(): Promise<void>;
      };
    };
  }
}

/**
 * Roomy's handle→DID resolver: Roomy's resolver at resolver.roomy.chat
 * (`xrpc/com.atproto.identity.resolveHandle`, returning `{did}`). Both OAuth modes
 * use it for sign-in, replacing the HappyView client's hardcoded DoH
 * (dns.google) and the @atproto client's default — so no login traffic ever
 * goes to Google. Overridable via `handleResolverUrl` (env
 * `VITE_HANDLE_RESOLVER_URL`).
 */
const DEFAULT_HANDLE_RESOLVER_URL =
  "https://resolver.roomy.chat/xrpc/com.atproto.identity.resolveHandle";

type AtprotoDidLike = `did:plc:${string}` | `did:web:${string}`;

function isAtprotoDidLike(value: unknown): value is AtprotoDidLike {
  return (
    typeof value === "string" &&
    (value.startsWith("did:plc:") || value.startsWith("did:web:"))
  );
}

/**
 * Structural match for `@atproto-labs/handle-resolver`'s `HandleResolver`
 * (accepted by both OAuth clients): resolves to the DID or `null` when the
 * handle is unknown. Network failures throw — a resolver outage must be
 * visible at login, not silently fall back to DNS.
 */
type HandleResolverLike = {
  resolve(
    handle: string,
    options?: { signal?: AbortSignal },
  ): Promise<AtprotoDidLike | null>;
};

/**
 * Build `HandleResolverLike` from `handleResolverUrl` (default:
 * `DEFAULT_HANDLE_RESOLVER_URL`), pointed at Roomy's resolver endpoint.
 */
function createRoomyHandleResolver(opts: {
  handleResolverUrl?: string | null;
  fetch?: typeof globalThis.fetch;
}): HandleResolverLike {
  const endpoint = (
    opts.handleResolverUrl || DEFAULT_HANDLE_RESOLVER_URL
  ).replace(/\/+$/, "");
  const fetchFn = opts.fetch ?? fetch;
  return {
    resolve: async (handle) => {
      const resp = await fetchFn(
        `${endpoint}?handle=${encodeURIComponent(handle)}`,
        { headers: [["accept", "application/json"]] },
      );
      if (!resp.ok) return null;
      const data: unknown = await resp.json();
      if (typeof data !== "object" || data === null || !("did" in data)) {
        return null;
      }
      const did: unknown = data.did;
      return isAtprotoDidLike(did) ? did : null;
    },
  };
}

// ── Config ────────────────────────────────────────────────────────────────

/**
 * The HappyView OAuth client metadata document served next to the native
 * (Tauri) build. The native build signs in via a custom-scheme deep link
 * (`space.roomy:/`), declared in that document's `redirect_uris`.
 */
const NATIVE_CLIENT_ID = "https://roomy.space/oauth-client-native.json";
const NATIVE_REDIRECT_URI = "space.roomy:/";

// ── Lexicon definitions (for atproto agent proxy) ─────────────────────────
//
// Generated lexicons live in ../schemas/lexicons/*.json and are auto-generated
// from the arktype schemas by `pnpm generate:lexicons`. Admin-only NSIDs
// that have no arktype schema are defined inline below.

import lexGetConnectionTicket from "../schemas/lexicons/space.roomy.auth.getConnectionTicket.json";
import lexGetLoginScope from "../schemas/lexicons/space.roomy.auth.getLoginScope.json";
import lexRecordScopeGrant from "../schemas/lexicons/space.roomy.auth.recordScopeGrant.json";
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
import lexReorderSpaces from "../schemas/lexicons/space.roomy.space.reorderSpaces.json";
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
                  required: [
                    "key",
                    "description",
                    "globalEnabled",
                    "assignedDids",
                  ],
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
  lexGetLoginScope,
  lexRecordScopeGrant,
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
  lexReorderSpaces,
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

/**
 * Options identifying the HappyView instance and the app's OAuth client.
 * `happyviewEndpoint`/`clientKey` come from build env (`VITE_HAPPYVIEW_ENDPOINT`,
 * `VITE_HAPPYVIEW_CLIENT_KEY` — the client key is a public identity, safe to
 * bundle; the client secret must only ever live server-side).
 */
export interface HappyViewClientOptions {
  /**
   * The HappyView instance's base HTTP origin, from build env. Left unset
   * (null) when not configured; set without `clientKey`, `createOAuthClient`
   * throws a clear error (half-configuration must not fall back to legacy).
   */
  happyviewEndpoint?: string | null;
  /**
   * API client key (`hvc_…`) registered on the HappyView instance — public
   * identity + rate-limit bucket, safe to bundle; the `hvs_…` secret must
   * never reach the browser. Left unset (null) when not configured; set
   * without `happyviewEndpoint`, `createOAuthClient` throws a clear error
   * (half-configuration must not fall back to legacy).
   */
  clientKey?: string | null;
  /**
   * URL of the app's served OAuth client metadata document (the OAuth
   * `client_id`). Governs BOTH modes: HappyView mode passes it through;
   * legacy mode fetches and parses it for the `@atproto/oauth-client-browser`
   * client. Unset → dev loopback client id, or the Tauri native document in
   * the desktop webview.
   */
  clientId?: string;
  /** Explicit OAuth redirect URI override. Defaults per environment. */
  redirectUri?: string;
  /** Pluggable fetch (tests). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Pluggable session persistence (tests). Defaults to localStorage in the
   * browser. Shape matches `@happyview/oauth-client`'s StorageAdapter
   * (not exported as a type there, so declared structurally).
   */
  storage?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /**
   * Handle→DID resolver used at sign-in. Defaults to Roomy's resolver
   * (resolver.roomy.chat/xrpc/com.atproto.identity.resolveHandle — the
   * standard atproto NSID; distinct from the Leaf handle endpoint the
   * space-handle settings page verifies), replacing the clients' DNS/DoH
   * resolution so no login traffic goes to dns.google.
   */
  handleResolverUrl?: string | null;
}

export interface CreateOAuthClientOptions extends HappyViewClientOptions {
  /** The port the local app listens on (for the dev loopback redirect URI). */
  port?: number;
  /**
   * OAuth scope string requested per login. If omitted, defaults to
   * `atproto transition:generic`. Callers that need explicit `rpc:` scopes
   * (e.g. app-lite) pass them here. This is only the *requested* scope — a
   * subset of the client's declared ceiling.
   */
  scope?: string;
  /**
   * The scope declared in the *dev loopback* client id
   * (`http://localhost?redirect_uri=…&scope=…`). The PDS derives the client's
   * metadata (including its scope ceiling) from the client id and records the
   * exact client-id string with the authorization request; the token exchange
   * and every later refresh must present the SAME client id or the PDS rejects
   * it with `invalid_grant: Token was not issued to this client`.
   *
   * Because the loopback client id embeds its scope, that scope MUST be stable
   * across the authorize call, the OAuth callback, and session restore — so it
   * is the app's full ceiling (a superset of every `scope` a login may
   * request), NOT the per-login scope. Defaults to `scope` for SDK consumers
   * that only ever request one scope. Ignored when an explicit `clientId` is
   * given (deployed/HappyView), where the client id is the metadata document
   * URL and is already stable.
   */
  clientIdScope?: string;
}

/** Default scope for SDK consumers that don't pass an explicit scope. */
const DEFAULT_SCOPE = "atproto transition:generic";

/**
 * The OAuth client Roomy runs in the browser: a HappyView-held DPoP session
 * client when HappyView is configured (web only), otherwise the legacy
 * direct-PDS `@atproto/oauth-client-browser` client.
 */
export type RoomyOAuthClient = HappyViewBrowserClient | BrowserOAuthClient;

export async function createOAuthClient(
  opts: CreateOAuthClientOptions = {},
): Promise<RoomyOAuthClient> {
  const hasHappyViewEndpoint = !!opts.happyviewEndpoint;
  const hasClientKey = !!opts.clientKey;

  // Desktop (Tauri) keeps the tested direct-PDS flow — the HappyView
  // deep-link sign-in path is untested there, so desktop builds ignore the
  // HappyView env (even a half-configured one) until it ships.
  if (window.__TAURI__) return createLegacyClient(opts);

  // A deployed HappyView web build serves confidential (private_key_jwt)
  // client metadata the legacy browser client cannot authorize with — a
  // half-configured build must fail loudly instead of silently falling back.
  if (hasHappyViewEndpoint !== hasClientKey) {
    throw new Error(
      "HappyView OAuth is half-configured: VITE_HAPPYVIEW_ENDPOINT and VITE_HAPPYVIEW_CLIENT_KEY must be set together (or neither)",
    );
  }
  if (hasHappyViewEndpoint) {
    return createHappyViewClient(opts);
  }
  // Legacy direct-PDS public client (pre-HappyView behavior).
  return createLegacyClient(opts);
}

async function createHappyViewClient(
  opts: CreateOAuthClientOptions,
): Promise<HappyViewBrowserClient> {
  if (!opts.happyviewEndpoint || !opts.clientKey) {
    throw new Error(
      "HappyView OAuth client requires VITE_HAPPYVIEW_ENDPOINT and VITE_HAPPYVIEW_CLIENT_KEY",
    );
  }

  const scope = opts.scope ?? DEFAULT_SCOPE;
  // Dev loopback client id scope: stable across authorize/callback/restore
  // (see `clientIdScope`). Defaults to the per-login scope for callers that
  // never vary it.
  const clientIdScope = opts.clientIdScope ?? scope;
  const tauri = window.__TAURI__;

  let clientId = opts.clientId;
  let redirectUri = opts.redirectUri;

  if (!clientId) {
    if (tauri) {
      // Desktop: sign in via the custom-scheme deep link, declared in the
      // native client metadata's redirect_uris.
      clientId = NATIVE_CLIENT_ID;
    } else {
      // Development: loopback client. The scope is embedded in the client id
      // per the atproto loopback convention (the AS derives the metadata from
      // the client id's query parameters — it never fetches localhost). It is
      // the STABLE `clientIdScope`, not the per-login `scope`: the PDS records
      // this exact client id and the callback must present it unchanged.
      const port = opts.port ?? 5199;
      const baseUrl = new URL(`http://127.0.0.1:${port}`);
      baseUrl.hash = "";
      baseUrl.pathname = "/";
      redirectUri = baseUrl.href;
      clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(clientIdScope)}`;
    }
  }
  if (!redirectUri) {
    if (tauri) {
      // The webview's origin is `tauri://localhost`, which is not a
      // registered redirect; the deep link is.
      redirectUri = NATIVE_REDIRECT_URI;
    } else {
      // Roomy's redirect convention: land on the homepage. Works for the
      // web deployment (its own origin) and for dev with an explicitly
      // configured client id (loopback origin). The metadata document and
      // the HappyView API client must both register this URI.
      redirectUri = new URL("/", location.origin).href;
    }
  }

  const client = new HappyViewBrowserClient({
    instanceUrl: opts.happyviewEndpoint,
    clientKey: opts.clientKey,
    clientId,
    redirectUri,
    scopes: scope,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.storage ? { storage: opts.storage } : {}),
  });
  // Replace the HappyView client's hardcoded DoH resolver (dns.google) with
  // Roomy's resolver: the class types `handleResolver` as its DoH
  // implementation (and marks it readonly), but the runtime contract is only
  // `.resolve(handle) → did | null` — which our resolver satisfies. It is a
  // plain property; assignment works.
  const writableClient = client as unknown as {
    handleResolver: HandleResolverLike;
  };
  writableClient.handleResolver = createRoomyHandleResolver(opts);

  // Never let the HappyView client retire a superseded session by contacting
  // its PDS. `registerSession` ends by calling `retirePreviousSession`, which
  // restores the previously stored session and issues a DELETE through its
  // `fetchHandler`; a dead stored refresh token makes that refresh throw
  // *synchronously*, which the client's bare `catch {}` around the call does
  // NOT cover — so it escapes `registerSession` and the user sees
  // "OAuthCallbackError: Failed to register session: …" after a re-login that
  // otherwise succeeded. The HappyView instance already revokes the previous
  // session in its own store, so the client-side retire is redundant. The
  // `patches/@happyview__oauth-client.patch` patch makes the same change in
  // the dependency; this guard also covers an unpatched install.
  const retire = (client as unknown as { retirePreviousSession?: unknown })
    .retirePreviousSession;
  if (typeof retire === "function") {
    (client as unknown as { retirePreviousSession: () => Promise<void> }).
      retirePreviousSession = async () => {};
  }
  return client;
}

/**
 * Legacy fallback (pre-HappyView): a direct-PDS `@atproto/oauth-client-browser`
 * public client. Dev builds a loopback client id; deployed builds fetch the
 * served metadata; Tauri fetches the native metadata and deep-links back.
 */
async function createLegacyClient(
  opts: CreateOAuthClientOptions,
): Promise<BrowserOAuthClient> {
  const scope = opts.scope ?? DEFAULT_SCOPE;
  // Dev loopback client: its scope lives in the client id, so the SAME scope
  // must back the id, the local metadata, and every callback/restore — use the
  // stable ceiling (`clientIdScope`), not the per-login `scope` (see that
  // option for why). Deployed/HappyView paths use a metadata URL as the client
  // id and ignore this.
  const clientIdScope = opts.clientIdScope ?? scope;
  const tauri = window.__TAURI__;

  // Desktop always uses the native deep-link document regardless of clientId overrides.
  if (tauri) {
    const req = await tauri.http.fetch(
      "https://roomy.space/oauth-client-native.json",
    );
    const clientMetadata = await req.json();
    return new BrowserOAuthClient({
      clientMetadata,
      handleResolver: createRoomyHandleResolver(opts),
      responseMode: "query",
    });
  }

  // Deployed: fetch the client metadata document (its URL is the client_id).
  if (opts.clientId) {
    const resp = await fetch(opts.clientId, {
      headers: [["accept", "application/json"]],
    });
    const clientMetadata = await resp.json();
    return new BrowserOAuthClient({
      clientMetadata,
      handleResolver: createRoomyHandleResolver(opts),
      responseMode: "query",
    });
  }

  // Development: loopback client. The PDS derives this client's metadata
  // (including its scope ceiling) from the client id's query parameters and
  // records the exact client id with the authorization request; the token
  // exchange and later refreshes must present it unchanged. The declared
  // `scope` must therefore equal the scope embedded in the id, and be a
  // superset of any per-login `scope` requested.
  const port = opts.port ?? 5199;
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  baseUrl.hash = "";
  baseUrl.pathname = "/";
  const redirectUri = baseUrl.href;

  const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(clientIdScope)}`;

  return new BrowserOAuthClient({
    clientMetadata: {
      ...atprotoLoopbackClientMetadata(buildLoopbackClientId(baseUrl)),
      redirect_uris: [redirectUri],
      scope: clientIdScope,
      client_id: clientId,
    },
    handleResolver: createRoomyHandleResolver(opts),
  });
}

// ── Proxied agent ─────────────────────────────────────────────────────────

/**
 * Create an atproto Agent configured to proxy XRPC calls through the
 * given appserver DID. Registers all known Roomy lexicons so the agent
 * knows how to serialize/deserialize them.
 *
 * NOTE: with a HappyView-held session the agent's requests already route
 * through HappyView (which ignores `atproto-proxy`), so this helper only
 * makes sense for callers holding a direct PDS session (e.g. the test-mode
 * app-password agent). app-lite uses `DirectXrpcClient` for appserver calls.
 */
export function makeProxiedAgent(agent: Agent, appserverDid: string): Agent {
  const proxied = agent.clone();
  proxied.configureProxy(
    `${appserverDid}#space_roomy_appserver` as unknown as Parameters<
      Agent["configureProxy"]
    >[0],
  );
  // JSON-imported lexicon objects are structurally LexiconDoc but infer as
  // widened literals; the runtime shape is what `lex.add` consumes.
  for (const lex of LEXICONS)
    proxied.lex.add(lex as unknown as Parameters<Agent["lex"]["add"]>[0]);
  return proxied;
}

// ── Session lifecycle ─────────────────────────────────────────────────────

/**
 * The session type behind `LoginResult`: a HappyView DPoP session
 * (HappyView-held mode) or the legacy `@atproto/oauth-client-browser`
 * OAuth session (direct-PDS fallback). Consumers rely on `.did`,
 * `.signOut()`, and the agent wrapping — both provide them.
 */
export type OAuthSession = HappyViewSession | AtprotoOAuthSession;

export interface InitSessionOptions extends CreateOAuthClientOptions {
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
 * The result of a completed or restored sign-in.
 *
 * `agent` is an `@atproto/api` `Agent` wrapping the HappyView session: all of
 * its typed XRPC calls (`com.atproto.repo.*`, `com.atproto.server.getServiceAuth`,
 * …) route through `session.fetchHandler` to the HappyView instance, which
 * serves Roomy lexicons locally and proxies standard atproto methods to the
 * user's PDS.
 */
export type LoginResult = {
  session: OAuthSession;
  agent: Agent;
  state?: string | null;
};

/**
 * Adapt a client's restored/callback session into a `LoginResult`.
 */
function toLoginResult(result: {
  session: OAuthSession;
  state?: string | null;
}): LoginResult {
  return {
    session: result.session,
    // HappyViewSession satisfies Agent's session contract (did +
    // fetchHandler + signOut) but is not the @atproto session class; the
    // Agent delegates every XRPC to session.fetchHandler.
    agent: new Agent(
      result.session as unknown as ConstructorParameters<typeof Agent>[0],
    ),
    state: result.state,
  };
}

/**
 * Try to restore an existing session (e.g. after a page reload or redirect
 * back from the PDS). Returns `{ session, agent, state }` if a session was
 * found, or `null` if the user is not authenticated. `state` is the OAuth
 * `state` value round-tripped through the PDS (present only when this call
 * processed an OAuth callback, not a plain session restore).
 */
export async function initSession(
  opts: InitSessionOptions = {},
): Promise<LoginResult | null> {
  const client = await createOAuthClient(opts);

  const result = await client.init();

  if (result?.session) {
    // `state` is only present when `init()` processed an OAuth callback
    // (URL contained callback params). On a plain session restore it is
    // `undefined`, so callers can distinguish the two cases.
    return toLoginResult(result);
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
  handle: string,
  opts: InitSessionOptions = {},
): Promise<void | LoginResult> {
  const client = await createOAuthClient(opts);

  const tauri = window.__TAURI__;
  if (tauri) {
    // opener IPC promise or the deep-link listener could in theory never settle.
    // Race the whole Tauri flow against a timeout so an abandoned login ALWAYS resolves,
    // letting the caller revert its loading state and surface the expiry.
    const timeoutMs = opts.loginTimeoutMs ?? 10 * 60_000;
    return await Promise.race([
      tauriLogin(client, handle, opts, tauri),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("Auth request has expired")),
          timeoutMs,
        ),
      ),
    ]);
  }

  if (client instanceof HappyViewBrowserClient) {
    await client.signIn(handle, authorizeRequestOptions(opts));
    return;
  }
  // Forward `state` (round-trip the return URL) and `scope` — the *subset*
  // the caller chose. Passing no `scope` makes the client fall back to
  // `clientMetadata.scope`, the full ceiling; see `authorizeRequestOptions`.
  await client.signIn(handle, authorizeRequestOptions(opts));
}

// Wait for the next deep-link event targeting this app. Resolves with the
// first URL (e.g. `space.roomy:/?state=…&code=…`) or `null` on timeout.
// The listener is removed on the first event (or after the timeout)
function waitForDeepLink(
  tauri: NonNullable<Window["__TAURI__"]>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    tauri.deepLink
      .onOpenUrl((urls) => {
        unlisten?.();
        const url = urls[0];
        if (!url) {
          reject(new Error("Error while opening url"));
          return;
        }
        resolve(url);
      })
      .then((unlistenFn) => {
        unlisten = unlistenFn;
      })
      .catch(reject);
  });
}

async function tauriLogin(
  client: RoomyOAuthClient,
  handle: string,
  opts: InitSessionOptions,
  tauri: NonNullable<Window["__TAURI__"]>,
): Promise<LoginResult> {
  if (client instanceof HappyViewBrowserClient) {
    const { authorizationUrl } = await client.prepareLogin(
      handle,
      authorizeRequestOptions(opts),
    );

    // Fire-and-forget. Promise may never settle on some platforms
    tauri.opener.openUrl(authorizationUrl);

    const deepUrl = await waitForDeepLink(tauri);

    // initCallback throws on error in query params
    const search = new URL(deepUrl).search;
    const result = await client.initCallback(search);
    if (result.session) return toLoginResult(result);
    throw new Error("Invalid session result");
  }

  const url = await client.authorize(handle, authorizeRequestOptions(opts));

  // Fire-and-forget. Promise may never settle on some platforms
  tauri.opener.openUrl(url);

  const deepUrl = await waitForDeepLink(tauri);

  // initCallback throws on error in query params
  const params = new URLSearchParams(new URL(deepUrl).search);
  const result = await client.initCallback(
    params,
    client.clientMetadata.redirect_uris[0],
  );
  if (result.session) return toLoginResult(result);
  throw new Error("Invalid session result");
}

/**
 * Sign out and clear all stored session state.
 *
 * The HappyView session revokes itself: the server deletes the stored
 * session (including the refresh token it custodies) and revokes the session
 * at the user's PDS. Local cleanup always happens, even when the server
 * refuses.
 */
export async function logout(session: OAuthSession): Promise<void> {
  await session.signOut();
}
