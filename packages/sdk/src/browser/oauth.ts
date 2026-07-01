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

// ── Config ────────────────────────────────────────────────────────────────

const HANDLE_RESOLVER = "https://bsky.social";

export const DEFAULT_APPSERVER_DID = "did:web:appserver.roomy.chat";

// ── Lexicon definitions (for atproto agent proxy) ─────────────────────────
//
// Generated lexicons live in ../schemas/lexicons/*.json and are auto-generated
// from the arktype schemas by `pnpm generate:lexicons`. Two admin-only NSIDs
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
}

/**
 * Try to restore an existing OAuth session (e.g. after a page reload or
 * redirect back from the PDS). Returns `{ session, agent, state }` if a
 * session was found, or `null` if the user is not authenticated. `state`
 * is the OAuth `state` value round-tripped through the PDS (present only
 * when this call processed an OAuth callback, not a plain session restore).
 */
export async function initSession(
  appserverDid: string,
  opts: InitSessionOptions = {},
): Promise<{ session: OAuthSession; agent: Agent; state?: string | null } | null> {
  const client = await createOAuthClient(appserverDid, opts);
  const result = await client.init();
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
 * Initiate an OAuth sign-in flow. This will redirect the browser to the
 * PDS authorization page; the promise does **not** resolve in the current
 * page context (the browser navigates away).
 */
export async function login(
  appserverDid: string,
  handle: string,
  opts: InitSessionOptions = {},
): Promise<void> {
  const client = await createOAuthClient(appserverDid, opts);
  // Forward `state` so the app can round-trip a return URL through the PDS.
  // The value comes back unchanged via `initSession()`'s `state` field.
  await client.signIn(handle, opts.state ? { state: opts.state } : undefined);
}

/**
 * Sign out and clear all stored session state.
 */
export async function logout(session: OAuthSession): Promise<void> {
  await session.signOut();
  sessionStorage.clear();
}
