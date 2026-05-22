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

// ── NSID constants ────────────────────────────────────────────────────────

const NSID_TICKET = "space.roomy.auth.getConnectionTicket";
const NSID_CONNECT_SPACE = "space.roomy.admin.connectSpace";
const NSID_MATERIALIZE_SPACE = "space.roomy.admin.materializeSpace";
const NSID_GET_SPACES = "space.roomy.space.getSpaces";
const NSID_GET_MEMBERS = "space.roomy.space.getMembers";
const NSID_GET_SPACE_METADATA = "space.roomy.space.getMetadata";
const NSID_GET_SPACE_THREADS = "space.roomy.space.getThreads";
const NSID_GET_ROLES = "space.roomy.space.getRoles";
const NSID_GET_INVITES = "space.roomy.space.getInvites";
const NSID_GET_ROOM_METADATA = "space.roomy.room.getMetadata";
const NSID_GET_ROOM_THREADS = "space.roomy.room.getThreads";
const NSID_GET_MESSAGES = "space.roomy.room.getMessages";
const NSID_GET_MESSAGE = "space.roomy.message.getMessage";
const NSID_UPDATE_SEEN = "space.roomy.room.updateSeen";
const NSID_SEND_EVENTS = "space.roomy.space.sendEvents";
const NSID_CREATE_SPACE = "space.roomy.space.createSpace";
const NSID_JOIN_SPACE = "space.roomy.space.joinSpace";
const NSID_LEAVE_SPACE = "space.roomy.space.leaveSpace";

// ── Lexicon definitions (for atproto agent proxy) ─────────────────────────

function spaceQueryLexicon(id: string) {
  return {
    lexicon: 1,
    id,
    defs: {
      main: {
        type: "query" as const,
        parameters: {
          type: "params" as const,
          required: ["spaceId"],
          properties: { spaceId: { type: "string" as const } },
        },
        output: { encoding: "application/json", schema: { type: "object" as const } },
      },
    },
  };
}

function roomQueryLexicon(
  id: string,
  extraProps: Record<string, { type: string }> = {},
) {
  return {
    lexicon: 1,
    id,
    defs: {
      main: {
        type: "query" as const,
        parameters: {
          type: "params" as const,
          required: ["roomId"],
          properties: { roomId: { type: "string" as const }, ...extraProps },
        },
        output: { encoding: "application/json", schema: { type: "object" as const } },
      },
    },
  };
}

const LEXICONS = [
  {
    lexicon: 1,
    id: NSID_TICKET,
    defs: {
      main: {
        type: "procedure" as const,
        output: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["ticket"],
            properties: { ticket: { type: "string" as const } },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_CONNECT_SPACE,
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
    id: NSID_GET_SPACES,
    defs: {
      main: {
        type: "query" as const,
        output: {
          encoding: "application/json",
          schema: { type: "object" as const },
        },
      },
    },
  },
  spaceQueryLexicon(NSID_GET_MEMBERS),
  spaceQueryLexicon(NSID_GET_SPACE_METADATA),
  spaceQueryLexicon(NSID_GET_SPACE_THREADS),
  spaceQueryLexicon(NSID_GET_ROLES),
  spaceQueryLexicon(NSID_GET_INVITES),
  roomQueryLexicon(NSID_GET_ROOM_METADATA),
  roomQueryLexicon(NSID_GET_ROOM_THREADS),
  roomQueryLexicon(NSID_GET_MESSAGES, {
    limit: { type: "string" },
    cursor: { type: "string" },
  }),
  {
    lexicon: 1,
    id: NSID_UPDATE_SEEN,
    defs: {
      main: {
        type: "procedure" as const,
        input: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["roomId"],
            properties: {
              roomId: { type: "string" as const },
              seenUpTo: { type: "string" as const },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_GET_MESSAGE,
    defs: {
      main: {
        type: "query" as const,
        parameters: {
          type: "params" as const,
          required: ["messageId"],
          properties: { messageId: { type: "string" as const } },
        },
        output: { encoding: "application/json", schema: { type: "object" as const } },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_SEND_EVENTS,
    defs: {
      main: {
        type: "procedure" as const,
        input: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["spaceId", "events"],
            properties: {
              spaceId: { type: "string" as const },
              events: { type: "array" as const },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_CREATE_SPACE,
    defs: {
      main: {
        type: "procedure" as const,
        input: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["name"],
            properties: {
              name: { type: "string" as const },
              description: { type: "string" as const },
              avatar: { type: "string" as const },
            },
          },
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["spaceId"],
            properties: { spaceId: { type: "string" as const } },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_JOIN_SPACE,
    defs: {
      main: {
        type: "procedure" as const,
        input: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["spaceId"],
            properties: {
              spaceId: { type: "string" as const },
              inviteToken: { type: "string" as const },
            },
          },
        },
        output: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["spaceId"],
            properties: { spaceId: { type: "string" as const } },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_LEAVE_SPACE,
    defs: {
      main: {
        type: "procedure" as const,
        input: {
          encoding: "application/json",
          schema: {
            type: "object" as const,
            required: ["spaceId"],
            properties: {
              spaceId: { type: "string" as const },
            },
          },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_MATERIALIZE_SPACE,
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
}

/**
 * Try to restore an existing OAuth session (e.g. after a page reload or
 * redirect back from the PDS). Returns `{ session, agent }` if a session
 * was found, or `null` if the user is not authenticated.
 */
export async function initSession(
  appserverDid: string,
  opts: InitSessionOptions = {},
): Promise<{ session: OAuthSession; agent: Agent } | null> {
  const client = await createOAuthClient(appserverDid, opts);
  const result = await client.init();
  if (result?.session) {
    return {
      session: result.session,
      agent: new Agent(result.session as any),
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
  await client.signIn(handle);
}

/**
 * Sign out and clear all stored session state.
 */
export async function logout(session: OAuthSession): Promise<void> {
  await session.signOut();
  sessionStorage.clear();
}
