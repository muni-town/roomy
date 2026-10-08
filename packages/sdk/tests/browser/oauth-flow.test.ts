/**
 * Functional verification of the OAuth session swap in
 * `src/browser/oauth.ts`, against a mocked HappyView instance + PDS
 * authorization server (injected `fetch`, in-memory storage — no network).
 *
 * Two modes under test:
 *
 * 1. HappyView-held session (envs configured): provisionDpopKey → PAR (+
 *    HappyView-minted client_assertion) → PDS token exchange (+ client
 *    assertion) → registerSession (refresh-token custody moves server-side)
 *    → proxied XRPC via `new Agent(session)` → `getServiceAuth` for
 *    appserver auth, proxied to the PDS.
 *
 * 2. Legacy fallback (envs unset): the pre-HappyView
 *    `@atproto/oauth-client-browser` loopback client.
 *
 * The load-bearing behavioral assertions:
 *   1. The token exchange happens as a *confidential* client (HappyView
 *      mints the `private_key_jwt` assertion for PAR and token exchange).
 *   2. The browser-side stored session contains NO refresh token — the
 *      refresh token is only sent to HappyView.
 *   3. Agent calls route to HappyView with DPoP auth + client key headers.
 *   4. Without HappyView envs the legacy loopback client is used.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Agent } from "@atproto/api";
import { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { HappyViewBrowserClient } from "@happyview/oauth-client-browser";
import { createOAuthClient, initSession, login } from "../../src/browser/oauth";
import { MemoryStorage } from "@happyview/oauth-client-browser";

const HV = "https://happyview.test";
const PDS = "https://pds.test";
const AS = "https://auth.pds.test";
const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const APPSERVER_DID = "did:web:appserver.test";
const SCOPE =
  "atproto rpc:com.atproto.server.getServiceAuth?aud=did:web:appserver.test";

// ── Captured requests (assertions read these) ────────────────────────────

const captured = {
  resolverCalls: [] as string[],
  parBody: {} as Record<string, string>,
  parHasDpopProof: false,
  tokenBody: {} as Record<string, string>,
  tokenHasDpopProof: false,
  registerBody: {} as Record<string, unknown>,
};
const HANDLE = "roomy-user.test";

// ── Mock HappyView + PDS + PLC ───────────────────────────────────────────

let dpopJwk: Record<string, unknown> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function formBody(bodyText: string): Record<string, string> {
  const params = new URLSearchParams(bodyText);
  return Object.fromEntries(params);
}

async function generateDpopJwk(): Promise<Record<string, unknown>> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  // The real provisioning endpoint returns a bare JWK (kty/crv/x/y/d/kid);
  // Node's exportKey adds `key_ops`/`ext`, which importJwk's public-key
  // import rejects (key_ops ["sign"] vs requested ["verify"]) — strip them.
  const {
    key_ops: _ops,
    ext: _ext,
    ...jwk
  } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey &
    Record<string, unknown>;
  return jwk;
}

async function mockFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // @atproto-labs/fetch passes Request objects; normalize once so string,
  // URL, and Request inputs (with merged headers/method/body) all work.
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const bodyText = await request.text();
  const headers = Object.fromEntries(request.headers);
  // Any DNS-over-HTTPS traffic in the mock universe is a bug: handle
  // resolution must go through Roomy's resolver endpoint.
  if (url.host === "dns.google") {
    throw new Error(`mockFetch: DNS-over-HTTPS traffic leaked to ${url.href}`);
  }

  // Roomy handle resolver (the standard atproto NSID served by resolver.roomy.chat).
  if (
    url.host === "resolver.roomy.chat" &&
    path === "/xrpc/com.atproto.identity.resolveHandle"
  ) {
    captured.resolverCalls.push(url.searchParams.get("handle") ?? "");
    if (url.searchParams.get("handle") === HANDLE) {
      return json({ did: DID });
    }
    return json({ error: "not found" }, 404);
  }

  // DID document for the test user's PLC DID.
  if (url.host === "plc.directory" && path === `/${encodeURIComponent(DID)}`) {
    return json({
      id: DID,
      service: [
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: PDS,
        },
      ],
    });
  }

  // PDS protected-resource metadata → point at the authorization server.
  if (url.origin === PDS && path === "/.well-known/oauth-protected-resource") {
    return json({ authorization_servers: [AS] });
  }

  // Authorization-server metadata.
  if (url.origin === AS && path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: AS,
      authorization_endpoint: `${AS}/oauth/authorization`,
      token_endpoint: `${AS}/oauth/token`,
      pushed_authorization_request_endpoint: `${AS}/oauth/par`,
    });
  }
  // PAR: must carry the DPoP proof; capture scope + client fields.
  if (url.origin === AS && path === "/oauth/par" && method === "POST") {
    captured.parBody = formBody(bodyText);
    captured.parHasDpopProof = Boolean(headers.dpop);
    return json({ request_uri: "urn:example:request_uri" });
  }

  // Token exchange: confidential client — must carry the client assertion.
  if (url.origin === AS && path === "/oauth/token" && method === "POST") {
    captured.tokenBody = formBody(bodyText);
    captured.tokenHasDpopProof = Boolean(headers.dpop);
    return json({
      access_token: "at_test_access",
      refresh_token: "rt_test_refresh",
      scope: captured.parBody.scope ?? SCOPE,
      iss: AS,
    });
  }

  // HappyView: DPoP key provisioning.
  if (url.origin === HV && path === "/oauth/dpop-keys" && method === "POST") {
    return json(
      { provision_id: "hvp_test", dpop_key: dpopJwk, confidential: true },
      201,
    );
  }

  // HappyView: client assertion minting.
  if (
    url.origin === HV &&
    path === "/oauth/client-assertion" &&
    method === "POST"
  ) {
    return json({
      client_assertion: "assertion_jwt",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      expires_in: 60,
      kid: "kid_test",
    });
  }

  // HappyView: session registration — the refresh token lands HERE.
  if (url.origin === HV && path === "/oauth/sessions" && method === "POST") {
    captured.registerBody = JSON.parse(bodyText || "{}");
    return json({ session_id: "sess_test", did: DID, scopes: [] }, 201);
  }

  // HappyView: proxied session revoke (signOut → deleteSession).
  if (
    url.origin === HV &&
    path === `/oauth/sessions/${DID}` &&
    method === "DELETE"
  ) {
    return new Response(null, { status: 204 });
  }

  // HappyView: proxied repo record read.
  if (url.origin === HV && path === "/xrpc/com.atproto.repo.getRecord") {
    expect(headers.authorization).toMatch(/^DPoP /);
    expect(headers.dpop).toBeTruthy();
    expect(headers["x-client-key"]).toBe("hvc_test");
    expect(url.searchParams.get("repo")).toBe(DID);
    return json({
      uri: `at://${DID}/space.roomy.user.profile/self`,
      cid: "bafkreicysg2ckiyc5xkxsej4v6dyhwbjwzbeurzqvnuyh733ojbxpx6xbe",
      value: { displayName: "Test User" },
    });
  }

  // HappyView: proxied getServiceAuth (appserver auth path).
  if (url.origin === HV && path === "/xrpc/com.atproto.server.getServiceAuth") {
    expect(url.searchParams.get("aud")).toBe(APPSERVER_DID);
    return json({ token: "service_auth_jwt" });
  }

  throw new Error(`mockFetch: unhandled ${method} ${url.href}`);
}

// ── Node/browser shims ───────────────────────────────────────────────────
// `oauth.ts` gates the Tauri flow on `window.__TAURI__`, reads bare
// `location.origin` for the redirect default, rewrites the address bar via
// `history.replaceState`, and the legacy fallback client touches browser
// storage (localStorage + IndexedDB).

beforeAll(() => {
  vi.stubGlobal("window", {
    location: { href: "http://127.0.0.1:5180/", pathname: "/", search: "" },
  });
  vi.stubGlobal("location", {
    origin: "http://127.0.0.1:5180",
    href: "http://127.0.0.1:5180/",
    pathname: "/",
    search: "",
  });
  vi.stubGlobal("history", { replaceState: () => {} });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  // The legacy fallback client opens IndexedDB eagerly in its constructor.
  vi.stubGlobal("indexedDB", {
    open: () => ({
      addEventListener: () => {},
      removeEventListener: () => {},
      set onsuccess(_v: unknown) {},
      set onerror(_v: unknown) {},
      set onupgradeneeded(_v: unknown) {},
      result: undefined,
    }),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("HappyView session lifecycle", () => {
  it("picks the client by configuration: HappyView when configured, legacy loopback otherwise", async () => {
    const legacy = await createOAuthClient({});
    expect(legacy).toBeInstanceOf(BrowserOAuthClient);
    const happy = await createOAuthClient({
      happyviewEndpoint: HV,
      clientKey: "hvc_test",
    });
    expect(happy).toBeInstanceOf(HappyViewBrowserClient);
  });

  it("returns null when no session is stored and no callback is present", async () => {
    const result = await initSession({
      happyviewEndpoint: HV,
      clientKey: "hvc_test",
      clientId: "https://app.test/oauth-client-metadata.json",
      fetch: mockFetch,
      storage: new MemoryStorage(),
    });
    expect(result).toBeNull();
  });

  it("completes the confidential DPoP flow and routes the agent through HappyView", async () => {
    dpopJwk = await generateDpopJwk();

    const client = await createOAuthClient({
      happyviewEndpoint: HV,
      clientKey: "hvc_test",
      clientId: "https://app.test/oauth-client-metadata.json",
      redirectUri: "https://app.test/",
      scope: SCOPE,
      fetch: mockFetch,
      storage: new MemoryStorage(),
    });
    expect(client).toBeInstanceOf(HappyViewBrowserClient);

    // prepareLogin: provision DPoP key, mint client assertion, PAR.
    const prepared = await client.prepareLogin(DID, { scope: SCOPE });
    expect(prepared.did).toBe(DID);
    expect(prepared.state).toBeTruthy();
    expect(prepared.authorizationUrl).toContain(`${AS}/oauth/authorization`);
    expect(prepared.authorizationUrl).toContain("request_uri=");

    // Confidential client: the PAR carried a HappyView-minted assertion and
    // the DPoP proof for the provisioned key.
    expect(captured.parBody.client_assertion).toBe("assertion_jwt");
    expect(captured.parBody.client_assertion_type).toContain("jwt-bearer");
    expect(captured.parBody.code_challenge).toBeTruthy();
    expect(captured.parHasDpopProof).toBe(true);
    expect(captured.parBody.scope).toBe(SCOPE);

    // The `state` that actually reaches the PDS is the client's own random
    // value, not a caller-supplied return URL. A conforming PDS enforces the
    // spec's entropy guidance (and rejects the page path app-lite used to
    // forward with `invalid_state`); the same value is also what makes the
    // callback a CSRF-checked round-trip.
    expect(captured.parBody.state).toMatch(/^[0-9a-f]{32}$/);
    expect(captured.parBody.state).not.toBe("/");

    // Callback: token exchange with assertion + session registration.
    const callback = await client.initCallback(
      `?state=${prepared.state}&code=auth_code_1`,
    );
    const session = callback.session;
    expect(session.did).toBe(DID);

    expect(captured.tokenBody.grant_type).toBe("authorization_code");
    expect(captured.tokenBody.client_assertion).toBe("assertion_jwt");
    expect(captured.tokenBody.code_verifier).toBeTruthy();
    expect(captured.tokenHasDpopProof).toBe(true);

    // The refresh token is handed to HappyView — and to nobody else.
    expect(captured.registerBody.refresh_token).toBe("rt_test_refresh");
    expect(captured.registerBody.provision_id).toBe("hvp_test");
    expect(captured.registerBody.access_token).toBe("at_test_access");

    // Agent over the HappyView session: typed calls route through the
    // instance with DPoP auth.
    const agent = new Agent(session);
    expect(agent.did).toBe(DID);
    const record = await agent.com.atproto.repo.getRecord({
      repo: DID,
      collection: "space.roomy.user.profile",
      rkey: "self",
    });
    expect(record.data.value).toEqual({ displayName: "Test User" });

    // Appserver auth still works: getServiceAuth proxied to the user's PDS.
    const auth = await agent.com.atproto.server.getServiceAuth({
      aud: APPSERVER_DID,
    });
    expect(auth.data.token).toBe("service_auth_jwt");

    // Sign-out revokes server-side (DELETE on the session endpoint).
    await session.signOut();
  });

  // Sign in by HANDLE: the client must use the Roomy resolver endpoint to
  // map it to the DID (and never dns.google — the mock throws on it).
  it("resolves handles through Roomy's resolver, never DNS-over-HTTPS", async () => {
    dpopJwk = await generateDpopJwk();
    captured.resolverCalls.length = 0;

    const client = await createOAuthClient({
      happyviewEndpoint: HV,
      clientKey: "hvc_test",
      clientId: "https://app.test/oauth-client-metadata.json",
      redirectUri: "https://app.test/",
      scope: SCOPE,
      fetch: mockFetch,
      storage: new MemoryStorage(),
    });

    const prepared = await client.prepareLogin(HANDLE, { scope: SCOPE });
    expect(prepared.did).toBe(DID);
    expect(captured.resolverCalls).toEqual([HANDLE]);

    const callback = await client.initCallback(
      `?state=${prepared.state}&code=auth_code_3`,
    );
    expect(callback.session?.did).toBe(DID);
  });
  it("persists the session without the refresh token in browser storage", async () => {
    dpopJwk = await generateDpopJwk();
    const storage = new MemoryStorage();
    const client = await createOAuthClient({
      happyviewEndpoint: HV,
      clientKey: "hvc_test",
      clientId: "https://app.test/oauth-client-metadata.json",
      redirectUri: "https://app.test/",
      scope: SCOPE,
      fetch: mockFetch,
      storage,
    });
    const prepared = await client.prepareLogin(DID, { scope: SCOPE });
    const callback = await client.initCallback(
      `?state=${prepared.state}&code=auth_code_2`,
    );
    expect(callback.session).toBeTruthy();

    const raw = await storage.get(`happyview:session:${DID}`);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw ?? "{}");
    expect(stored.refresh_token).toBeUndefined();
    expect(stored.refreshToken).toBeUndefined();
    expect(stored.accessToken).toBe("at_test_access");
    // The DPoP private key IS in the browser (shared with HappyView).
    expect((stored.dpopKey as Record<string, unknown>).d).toBeTruthy();
  });

  // The regression that broke self-hosted sign-in: app-lite passed the page
  // path as `state`, so the PAR carried a one-character value (`/`) that an
  // OAuth-conforming PDS rejects with `invalid_state`, and the callback had no
  // CSRF protection. This drives the real `login()` seam with a page path in
  // `opts.state` and asserts on the bytes that reach the PDS.
  it("sends an unguessable, per-attempt random state in the PAR body", async () => {
    dpopJwk = await generateDpopJwk();
    const states: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      await login(HANDLE, {
        happyviewEndpoint: HV,
        clientKey: "hvc_test",
        clientId: "https://app.test/oauth-client-metadata.json",
        redirectUri: "https://app.test/",
        scope: SCOPE,
        fetch: mockFetch,
        storage: new MemoryStorage(),
        // The value app-lite used to forward. The SDK must not let it through.
        state: "/space/1",
      } as unknown as Parameters<typeof login>[1]);
      states.push(captured.parBody.state);
    }

    for (const state of states) {
      // OAuth's state-entropy guidance, and the length a strict PDS enforces.
      expect(state.length).toBeGreaterThanOrEqual(8);
      // Not the page path, not a guessable short string.
      expect(state).not.toBe("/space/1");
      expect(state).not.toBe("/");
    }
    // A fresh value per attempt, not one reused across sign-ins.
    expect(states[0]).not.toBe(states[1]);
  });
});
