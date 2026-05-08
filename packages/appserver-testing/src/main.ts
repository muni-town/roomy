import {
  BrowserOAuthClient,
  atprotoLoopbackClientMetadata,
  buildLoopbackClientId,
} from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";

// ── Config ────────────────────────────────────────────────────────────────

const PORT = 5199;
const HANDLE_RESOLVER = "https://resolver.roomy.chat";
const DEFAULT_APPSERVER_DID = "did:web:appserver.roomy.chat";
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

// The appserver DID is baked into the OAuth scope (rpc:<nsid>?aud=<did>),
// so the client must be created after we know the DID.

function buildScope(_appserverDid: string) {
  // transition:generic permits proxied calls to any RPC method on any
  // service. This is the simplest path while we're iterating; when the
  // surface stabilises we can narrow it back to per-NSID rpc: scopes.
  return "atproto transition:generic";
}

function createOAuthClient(appserverDid: string) {
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

// ── DOM helpers ───────────────────────────────────────────────────────────

const app = document.getElementById("app")!;
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// ── Module state ───────────────────────────────────────────────────────────

let currentSession: import("@atproto/oauth-client-browser").OAuthSession | null = null;

// ── Persisted appserver DID across redirects ──────────────────────────────

function saveAppserverDid(did: string) {
  sessionStorage.setItem("appserver-did", did);
}

function loadAppserverDid(): string {
  return sessionStorage.getItem("appserver-did") || DEFAULT_APPSERVER_DID;
}

// ── Login state ───────────────────────────────────────────────────────────

function showLogin(storedDid: string) {
  app.innerHTML = `
    <h1>Appserver Testing</h1>
    <p class="subtitle">PDS proxy auth validation</p>
    <div class="steps">
      <strong>Prerequisites:</strong> Start a tunnel to the appserver and set
      <code>APPSERVER_DID</code> / <code>APPSERVER_ORIGIN</code> accordingly.
      For example with Tailscale Funnel:<br />
      <code>tailscale serve --bg --tunneled-port 8080 http://localhost:8080</code>
    </div>
    <label for="appserver-did">Appserver DID</label>
    <input id="appserver-did" type="text" value="${storedDid}" />
    <label for="handle">ATProto handle</label>
    <input id="handle" type="text" placeholder="user.bsky.social" />
    <br />
    <button id="login" class="primary">Login</button>
  `;

  $<HTMLButtonElement>("login").onclick = async () => {
    const handle = $<HTMLInputElement>("handle").value.trim();
    const appserverDid = $<HTMLInputElement>("appserver-did").value.trim();
    if (!handle || !appserverDid) return;

    saveAppserverDid(appserverDid);
    const loginBtn = $<HTMLButtonElement>("login");
    loginBtn.textContent = "Redirecting...";
    loginBtn.disabled = true;

    const client = createOAuthClient(appserverDid);
    await client.signIn(handle);
  };
}

function showAuthenticated(agent: Agent, appserverDid: string) {
  const storedStreamDid = sessionStorage.getItem("stream-did") ?? "";
  app.innerHTML = `
    <h1>Appserver Testing</h1>
    <p>Authenticated as <strong>${agent.did}</strong></p>
    <p>Appserver DID: <strong>${appserverDid}</strong></p>
    <p class="status">Scope: <code>atproto transition:generic</code></p>

    <h2>Auth ticket</h2>
    <button id="test" class="primary">Get Connection Ticket</button>

    <h2>Admin: space ops</h2>
    <p class="subtitle">Caller DID must be on the appserver's
      <code>APPSERVER_ADMIN_DIDS</code> allowlist.</p>
    <label for="stream-did">Stream DID</label>
    <input id="stream-did" type="text" placeholder="did:key:..." value="${storedStreamDid}" />
    <br />
    <button id="connect-space">Connect Space</button>
    <button id="materialize-space">Materialize Space</button>
    <button id="materialize-space-wait">Materialize + Wait Backfill</button>

    <h2>Reads</h2>
    <button id="get-spaces" class="primary">Get My Spaces</button>

    <h3>Space queries</h3>
    <label for="space-id">Space ID</label>
    <input id="space-id" type="text" placeholder="did:web:..." value="${sessionStorage.getItem("space-id") ?? ""}" />
    <br />
    <button id="get-space-metadata">Get Metadata</button>
    <button id="get-members">Get Members</button>
    <button id="get-space-threads">Get Threads</button>
    <button id="get-roles">Get Roles</button>
    <button id="get-invites">Get Invites</button>

    <h3>Room queries</h3>
    <label for="room-id">Room ID</label>
    <input id="room-id" type="text" placeholder="01..." value="${sessionStorage.getItem("room-id") ?? ""}" />
    <br />
    <label for="message-limit">limit</label>
    <input id="message-limit" type="number" min="1" max="100" value="${sessionStorage.getItem("message-limit") ?? "50"}" style="width:5em" />
    <label for="message-cursor">cursor</label>
    <input id="message-cursor" type="text" placeholder="(optional)" value="${sessionStorage.getItem("message-cursor") ?? ""}" />
    <br />
    <button id="get-room-metadata">Get Metadata</button>
    <button id="get-room-threads">Get Threads</button>
    <button id="get-messages">Get Messages</button>

    <h3>Message query</h3>
    <label for="message-id">Message ID</label>
    <input id="message-id" type="text" placeholder="01..." value="${sessionStorage.getItem("message-id") ?? ""}" />
    <br />
    <button id="get-message">Get Message</button>

    <button id="logout">Logout</button>
    <pre id="result" class="status">Ready</pre>
  `;

  $("test").onclick = () => callTicket(agent, appserverDid);
  $("connect-space").onclick = () => callConnectSpace(agent, appserverDid);
  $("materialize-space").onclick = () =>
    callMaterializeSpace(agent, appserverDid, false);
  $("materialize-space-wait").onclick = () =>
    callMaterializeSpace(agent, appserverDid, true);
  $("get-spaces").onclick = () => callGetSpaces(agent, appserverDid);
  $("get-members").onclick = () => callSpaceQuery(agent, appserverDid, NSID_GET_MEMBERS, "Fetching members");
  $("get-space-metadata").onclick = () => callSpaceQuery(agent, appserverDid, NSID_GET_SPACE_METADATA, "Fetching space metadata");
  $("get-space-threads").onclick = () => callSpaceQuery(agent, appserverDid, NSID_GET_SPACE_THREADS, "Fetching threads");
  $("get-roles").onclick = () => callSpaceQuery(agent, appserverDid, NSID_GET_ROLES, "Fetching roles");
  $("get-invites").onclick = () => callSpaceQuery(agent, appserverDid, NSID_GET_INVITES, "Fetching invites");
  $("get-room-metadata").onclick = () => callRoomQuery(agent, appserverDid, NSID_GET_ROOM_METADATA, "Fetching room metadata");
  $("get-room-threads").onclick = () => callRoomQuery(agent, appserverDid, NSID_GET_ROOM_THREADS, "Fetching room threads");
  $("get-messages").onclick = () => callGetMessages(agent, appserverDid);
  $("get-message").onclick = () => callGetMessage(agent, appserverDid);
  $("logout").onclick = async () => {
    if (currentSession) {
      await currentSession.signOut();
    }
    sessionStorage.clear();
    location.reload();
  };
}

// ── XRPC calls via PDS proxy ──────────────────────────────────────────────

function makeProxiedAgent(agent: Agent, appserverDid: string): Agent {
  const proxied = agent.clone();
  proxied.configureProxy(
    // The Agent's `configureProxy` signature is over a known set of service
    // types; cast through `unknown` because our service id (`space_roomy_appserver`)
    // is intentionally outside the upstream allowlist for now.
    `${appserverDid}#space_roomy_appserver` as unknown as Parameters<
      Agent["configureProxy"]
    >[0],
  );
  for (const lex of LEXICONS) proxied.lex.add(lex as any);
  return proxied;
}

function readStreamDid(): string | null {
  const value = $<HTMLInputElement>("stream-did").value.trim();
  if (!value) {
    renderResult({ error: "Missing stream DID" }, true);
    return null;
  }
  sessionStorage.setItem("stream-did", value);
  return value;
}

function renderResult(value: unknown, isError = false) {
  const result = $("result")!;
  result.className = isError ? "error" : "";
  result.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function disableButtons(disabled: boolean) {
  for (const id of [
    "test",
    "connect-space",
    "materialize-space",
    "materialize-space-wait",
    "get-spaces",
    "get-members",
    "get-space-metadata",
    "get-space-threads",
    "get-roles",
    "get-invites",
    "get-room-metadata",
    "get-room-threads",
    "get-messages",
    "get-message",
  ]) {
    $<HTMLButtonElement>(id).disabled = disabled;
  }
}

function readPersistedInput(id: string, label: string): string | null {
  const value = $<HTMLInputElement>(id).value.trim();
  if (!value) {
    renderResult({ error: `Missing ${label}` }, true);
    return null;
  }
  sessionStorage.setItem(id, value);
  return value;
}

function readSpaceId(): string | null {
  return readPersistedInput("space-id", "space ID");
}

function readRoomId(): string | null {
  return readPersistedInput("room-id", "room ID");
}

function readMessageId(): string | null {
  return readPersistedInput("message-id", "message ID");
}

async function runCall(label: string, fn: () => Promise<unknown>) {
  renderResult(`${label}…`);
  disableButtons(true);
  try {
    const data = await fn();
    renderResult(data);
  } catch (err: any) {
    const detail = err?.headers
      ? `\n\nHeaders: ${JSON.stringify(err.headers, null, 2)}`
      : "";
    renderResult(
      `${err?.error || "Error"}: ${err?.message || err}${detail}`,
      true,
    );
  } finally {
    disableButtons(false);
  }
}

async function callTicket(agent: Agent, appserverDid: string) {
  await runCall("Requesting connection ticket", async () => {
    const proxied = makeProxiedAgent(agent, appserverDid);
    const response = await proxied.call(NSID_TICKET);
    return response.data;
  });
}

async function callConnectSpace(agent: Agent, appserverDid: string) {
  const did = readStreamDid();
  if (!did) return;
  await runCall("Connecting to space", async () => {
    const proxied = makeProxiedAgent(agent, appserverDid);
    const response = await proxied.call(NSID_CONNECT_SPACE, { did });
    return response.data;
  });
}

async function callMaterializeSpace(
  agent: Agent,
  appserverDid: string,
  waitBackfill: boolean,
) {
  const did = readStreamDid();
  if (!did) return;
  await runCall(
    waitBackfill
      ? "Materializing space (awaiting backfill)"
      : "Materializing space",
    async () => {
      const proxied = makeProxiedAgent(agent, appserverDid);
      const params: Record<string, string> = { did };
      if (waitBackfill) params.wait = "backfill";
      const response = await proxied.call(NSID_MATERIALIZE_SPACE, params);
      return response.data;
    },
  );
}

async function callGetSpaces(agent: Agent, appserverDid: string) {
  await runCall("Fetching joined spaces", async () => {
    const proxied = makeProxiedAgent(agent, appserverDid);
    const response = await proxied.call(NSID_GET_SPACES);
    return response.data;
  });
}

async function callSpaceQuery(
  agent: Agent,
  appserverDid: string,
  nsid: string,
  label: string,
) {
  const spaceId = readSpaceId();
  if (!spaceId) return;
  await runCall(label, async () => {
    const proxied = makeProxiedAgent(agent, appserverDid);
    const response = await proxied.call(nsid, { spaceId });
    return response.data;
  });
}

async function callRoomQuery(
  agent: Agent,
  appserverDid: string,
  nsid: string,
  label: string,
) {
  const roomId = readRoomId();
  if (!roomId) return;
  await runCall(label, async () => {
    const proxied = makeProxiedAgent(agent, appserverDid);
    const response = await proxied.call(nsid, { roomId });
    return response.data;
  });
}

async function callGetMessages(agent: Agent, appserverDid: string) {
  const roomId = readRoomId();
  if (!roomId) return;
  const limit = $<HTMLInputElement>("message-limit").value.trim();
  const cursor = $<HTMLInputElement>("message-cursor").value.trim();
  if (limit) sessionStorage.setItem("message-limit", limit);
  if (cursor) sessionStorage.setItem("message-cursor", cursor);
  await runCall("Fetching messages", async () => {
    const proxied = makeProxiedAgent(agent, appserverDid);
    const params: Record<string, string> = { roomId };
    if (limit) params.limit = limit;
    if (cursor) params.cursor = cursor;
    const response = await proxied.call(NSID_GET_MESSAGES, params);
    return response.data;
  });
}

async function callGetMessage(agent: Agent, appserverDid: string) {
  const messageId = readMessageId();
  if (!messageId) return;
  await runCall("Fetching message", async () => {
    const proxied = makeProxiedAgent(agent, appserverDid);
    const response = await proxied.call(NSID_GET_MESSAGE, { messageId });
    return response.data;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const storedDid = loadAppserverDid();

  // Try to restore session using the stored appserver DID
  const client = createOAuthClient(storedDid);
  const result = await client.init();

  if (result?.session) {
    currentSession = result.session;
    const agent = new Agent(result.session as any);
    showAuthenticated(agent, storedDid);
  } else {
    showLogin(storedDid);
  }
}

main().catch((err) => {
  app.innerHTML = `<pre class="error">Init failed: ${err}</pre>`;
});
