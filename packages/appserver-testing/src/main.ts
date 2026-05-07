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

    <button id="logout">Logout</button>
    <pre id="result" class="status">Ready</pre>
  `;

  $("test").onclick = () => callTicket(agent, appserverDid);
  $("connect-space").onclick = () => callConnectSpace(agent, appserverDid);
  $("materialize-space").onclick = () =>
    callMaterializeSpace(agent, appserverDid, false);
  $("materialize-space-wait").onclick = () =>
    callMaterializeSpace(agent, appserverDid, true);
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
  ]) {
    $<HTMLButtonElement>(id).disabled = disabled;
  }
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
