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
const NSID = "space.roomy.auth.getConnectionTicket";

// ── Lexicon ───────────────────────────────────────────────────────────────

const LEXICON = {
  lexicon: 1,
  id: NSID,
  defs: {
    main: {
      type: "procedure",
      output: {
        encoding: "application/json",
        schema: {
          type: "object",
          required: ["ticket"],
          properties: {
            ticket: { type: "string" },
          },
        },
      },
    },
  },
};

// ── OAuth client setup ────────────────────────────────────────────────────

// The appserver DID is baked into the OAuth scope (rpc:<nsid>?aud=<did>),
// so the client must be created after we know the DID.

function buildScope(_appserverDid: string) {
  return `atproto rpc:${NSID}?aud=*`;
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

  $("login").onclick = async () => {
    const handle = $("handle").value.trim();
    const appserverDid = $("appserver-did").value.trim();
    if (!handle || !appserverDid) return;

    saveAppserverDid(appserverDid);
    $("login").textContent = "Redirecting...";
    $("login").disabled = true;

    const client = createOAuthClient(appserverDid);
    await client.signIn(handle);
  };
}

function showAuthenticated(agent: Agent, appserverDid: string) {
  app.innerHTML = `
    <h1>Appserver Testing</h1>
    <p>Authenticated as <strong>${agent.did}</strong></p>
    <p>Appserver DID: <strong>${appserverDid}</strong></p>
    <p class="status">Scope: <code>atproto transition:generic</code></p>
    <button id="test" class="primary">Test Proxy Auth</button>
    <button id="logout">Logout</button>
    <pre id="result" class="status">Ready</pre>
  `;

  $("test").onclick = () => testProxyAuth(agent, appserverDid);
  $("logout").onclick = async () => {
    if (currentSession) {
      await currentSession.signOut();
    }
    sessionStorage.clear();
    location.reload();
  };
}

// ── Proxy test ────────────────────────────────────────────────────────────

async function testProxyAuth(agent: Agent, appserverDid: string) {
  const result = $("result")!;
  const testBtn = $("test") as HTMLButtonElement;

  result.className = "status";
  result.textContent = "Sending proxied request through PDS...";
  testBtn.disabled = true;

  try {
    const proxied = agent.clone();
    proxied.configureProxy(
      `${appserverDid}#space_roomy_appserver` as `${string}#${string}`,
    );
    proxied.lex.add(LEXICON);

    const response = await proxied.call(NSID);

    result.className = "";
    result.textContent = JSON.stringify(response.data, null, 2);
  } catch (err: any) {
    result.className = "error";
    const detail = err?.headers
      ? `\n\nHeaders: ${JSON.stringify(err.headers, null, 2)}`
      : "";
    result.textContent = `${err?.error || "Error"}: ${err?.message || err}${detail}`;
  } finally {
    testBtn.disabled = false;
  }
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
