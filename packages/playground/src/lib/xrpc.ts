import {
  BrowserOAuthClient,
  atprotoLoopbackClientMetadata,
  buildLoopbackClientId,
} from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";
import { decodeFirst } from "@atcute/cbor";
import type { OAuthSession } from "@atproto/oauth-client-browser";

// ── Config ────────────────────────────────────────────────────────────────

export const PORT = 5199;
const HANDLE_RESOLVER = "https://resolver.roomy.chat";
export const DEFAULT_APPSERVER_DID = "did:web:appserver.roomy.chat";
export const NSID_TICKET = "space.roomy.auth.getConnectionTicket";
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

function spaceQueryLexicon(id: string) {
  return {
    lexicon: 1,
    id,
    defs: {
      main: {
        type: "query",
        parameters: {
          type: "params",
          required: ["spaceId"],
          properties: { spaceId: { type: "string" } },
        },
        output: { encoding: "application/json", schema: { type: "object" } },
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
        type: "query",
        parameters: {
          type: "params",
          required: ["roomId"],
          properties: { roomId: { type: "string" }, ...extraProps },
        },
        output: { encoding: "application/json", schema: { type: "object" } },
      },
    },
  };
}

// ── Lexicons ──────────────────────────────────────────────────────────────

const LEXICONS = [
  {
    lexicon: 1,
    id: NSID_TICKET,
    defs: {
      main: {
        type: "procedure",
        output: {
          encoding: "application/json",
          schema: {
            type: "object",
            required: ["ticket"],
            properties: { ticket: { type: "string" } },
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
        type: "query",
        parameters: {
          type: "params",
          required: ["did"],
          properties: { did: { type: "string" } },
        },
        output: {
          encoding: "application/json",
          schema: { type: "object" },
        },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_GET_SPACES,
    defs: {
      main: {
        type: "query",
        output: {
          encoding: "application/json",
          schema: { type: "object" },
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
    id: NSID_GET_MESSAGE,
    defs: {
      main: {
        type: "query",
        parameters: {
          type: "params",
          required: ["messageId"],
          properties: { messageId: { type: "string" } },
        },
        output: { encoding: "application/json", schema: { type: "object" } },
      },
    },
  },
  {
    lexicon: 1,
    id: NSID_MATERIALIZE_SPACE,
    defs: {
      main: {
        type: "query",
        parameters: {
          type: "params",
          required: ["did"],
          properties: {
            did: { type: "string" },
            wait: { type: "string" },
          },
        },
        output: {
          encoding: "application/json",
          schema: { type: "object" },
        },
      },
    },
  },
];

// ── OAuth client setup ────────────────────────────────────────────────────

function buildScope(_appserverDid: string) {
  return "atproto transition:generic";
}

export function createOAuthClient(appserverDid: string) {
  const scope = buildScope(appserverDid);

  const baseUrl = new URL(`http://127.0.0.1:${PORT}`);
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

// ── XRPC call helpers ─────────────────────────────────────────────────────

export async function callTicket(agent: Agent, appserverDid: string) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(NSID_TICKET);
  return response.data;
}

export async function callConnectSpace(agent: Agent, appserverDid: string, did: string) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(NSID_CONNECT_SPACE, { did });
  return response.data;
}

export async function callMaterializeSpace(
  agent: Agent,
  appserverDid: string,
  did: string,
  waitBackfill: boolean,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const params: Record<string, string> = { did };
  if (waitBackfill) params.wait = "backfill";
  const response = await proxied.call(NSID_MATERIALIZE_SPACE, params);
  return response.data;
}

export async function callGetSpaces(agent: Agent, appserverDid: string) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(NSID_GET_SPACES);
  return response.data;
}

export async function callSpaceQuery(
  agent: Agent,
  appserverDid: string,
  nsid: string,
  spaceId: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(nsid, { spaceId });
  return response.data;
}

export async function callRoomQuery(
  agent: Agent,
  appserverDid: string,
  nsid: string,
  roomId: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(nsid, { roomId });
  return response.data;
}

export async function callGetMessages(
  agent: Agent,
  appserverDid: string,
  roomId: string,
  limit?: string,
  cursor?: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const params: Record<string, string> = { roomId };
  if (limit) params.limit = limit;
  if (cursor) params.cursor = cursor;
  const response = await proxied.call(NSID_GET_MESSAGES, params);
  return response.data;
}

export async function callGetMessage(
  agent: Agent,
  appserverDid: string,
  messageId: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(NSID_GET_MESSAGE, { messageId });
  return response.data;
}

// ── NSID constants for space/room queries ──────────────────────────────────

export const NSIDS = {
  GET_MEMBERS: NSID_GET_MEMBERS,
  GET_SPACE_METADATA: NSID_GET_SPACE_METADATA,
  GET_SPACE_THREADS: NSID_GET_SPACE_THREADS,
  GET_ROLES: NSID_GET_ROLES,
  GET_INVITES: NSID_GET_INVITES,
  GET_ROOM_METADATA: NSID_GET_ROOM_METADATA,
  GET_ROOM_THREADS: NSID_GET_ROOM_THREADS,
} as const;

// ── WebSocket sync ────────────────────────────────────────────────────────

export function decodeCborFrame(data: ArrayBuffer): { header: Record<string, unknown>; body: Record<string, unknown> } {
  const bytes = new Uint8Array(data);
  const [header, remainder] = decodeFirst(bytes);
  const body = remainder.byteLength > 0 ? decodeFirst(remainder)[0] as Record<string, unknown> : {};
  return { header: header as Record<string, unknown>, body };
}

// ── Session helpers ───────────────────────────────────────────────────────

export function saveAppserverDid(did: string) {
  sessionStorage.setItem("appserver-did", did);
}

export function loadAppserverDid(): string {
  return sessionStorage.getItem("appserver-did") || DEFAULT_APPSERVER_DID;
}

export async function initSession(appserverDid: string): Promise<{
  session: OAuthSession;
  agent: Agent;
} | null> {
  const client = createOAuthClient(appserverDid);
  const result = await client.init();
  if (result?.session) {
    return {
      session: result.session,
      agent: new Agent(result.session as any),
    };
  }
  return null;
}

export async function login(appserverDid: string, handle: string) {
  const client = createOAuthClient(appserverDid);
  await client.signIn(handle);
}

export async function logout(session: OAuthSession) {
  await session.signOut();
  sessionStorage.clear();
}
