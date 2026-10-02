/**
 * Unit tests for the OAuth `login()` scope forwarding.
 *
 * The per-login `scope` opts (e.g. app-lite's `SCOPE_SETS.base`) MUST reach
 * the PDS authorization request. The browser client's `authorize()` falls back
 * to `clientMetadata.scope` — the FULL metadata ceiling, which declares every
 * scope Roomy might ever want (including tiers a caller deliberately withheld)
 * — when no per-request `scope` is supplied. So a `login()` that drops
 * `opts.scope` silently re-requests the ceiling on every first login: the
 * exact failure "do not request Chat access at the default/initial scope"
 * describes. These tests pin the forwarding on BOTH the web (`signIn`) and
 * Tauri (`authorize`) paths.
 *
 * `@atproto/oauth-client-browser` is mocked: it pulls in WebCrypto/IndexedDB
 * and a full client instantiation would hit the network. We assert only the
 * arguments `login()` hands the client, which is the contract under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const signIn = vi.fn(async () => undefined);
const authorize = vi.fn(async () => new URL("https://pds.example/oauth/authorize"));
/**
 * `client_id` of every `BrowserOAuthClient` the code under test builds. A
 * `vi.mock` factory cannot close over imports, so the shape is declared here
 * as the exact slice the loopback path writes and the test reads.
 */
type CapturedClientOpts = {
  clientMetadata?: { client_id?: string; scope?: string };
};
const clientOpts: CapturedClientOpts[] = [];

vi.mock("@atproto/oauth-client-browser", () => {
  class BrowserOAuthClient {
    static clientMetadata = { redirect_uris: ["https://app.example/"] };
    clientMetadata = BrowserOAuthClient.clientMetadata;
    signIn = signIn;
    authorize = authorize;
    constructor(opts: CapturedClientOpts) {
      clientOpts.push(opts);
    }
  }
  return {
    BrowserOAuthClient,
    atprotoLoopbackClientMetadata: () => ({ redirect_uris: ["http://127.0.0.1/"] }),
    buildLoopbackClientId: () => "http://localhost",
  };
});

import { login } from "./oauth";

const HANDLE = "alice.example";
const BASE = "atproto rpc:space.roomy.space.getSpaces?aud=*";

/**
 * Minimal browser-ish globals `createOAuthClient`/`login` read. `fetch` is
 * stubbed for the deployed-metadata path (`clientId`), which fetches the served
 * `oauth-client-metadata.json`.
 */
function stubGlobals(opts: { tauri?: boolean } = {}) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, v),
  };
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ redirect_uris: ["https://app.example/"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("sessionStorage", storage);
  if (opts.tauri) {
    vi.stubGlobal("window", {
      __TAURI__: {
        http: {
          fetch: async () => ({
            json: async () => ({ redirect_uris: ["space.roomy:/"] }),
          }),
        },
        opener: { openUrl: () => {} },
        deepLink: { onOpenUrl: () => new Promise<() => void>(() => {}) },
      },
    });
  } else {
    vi.stubGlobal("window", {});
  }
}

describe("login() scope forwarding", () => {
  beforeEach(() => {
    signIn.mockClear();
    authorize.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clientOpts.length = 0;
  });

  it("forwards the requested scope to signIn (web path)", async () => {
    stubGlobals();
    await login(HANDLE, { scope: BASE });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith(HANDLE, { scope: BASE });
  });

  it("forwards state AND scope together when both are supplied", async () => {
    stubGlobals();
    await login(HANDLE, {
      scope: BASE,
      state: "/some/room",
    });

    expect(signIn).toHaveBeenCalledWith(HANDLE, {
      state: "/some/room",
      scope: BASE,
    });
  });

  it("omits options entirely when neither state nor scope is supplied", async () => {
    // Preserves the prior behaviour: no per-request override, so the client
    // uses its metadata ceiling (the SDK default path for non-app-lite callers).
    stubGlobals();
    await login(HANDLE, {});

    expect(signIn).toHaveBeenCalledWith(HANDLE, undefined);
  });

  it("forwards the requested scope to authorize (Tauri path)", async () => {
    stubGlobals({ tauri: true });

    // The Tauri path blocks on the deep-link callback, which never arrives
    // here, so race it against a very short timeout — the assertion is on the
    // `authorize` call already made before the wait.
    await login(HANDLE, {
      scope: BASE,
      loginTimeoutMs: 50,
    }).catch(() => {});

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(HANDLE, { scope: BASE });
  });

  it("builds the dev loopback client_id from clientIdScope, not the per-login scope", async () => {
    // Regression: the dev loopback client id embeds its scope. The PDS records
    // that exact client id with the authorization request and rejects a
    // differing one at token exchange/refresh with
    // `invalid_grant: Token was not issued to this client`. So the id must be
    // backed by the STABLE `clientIdScope` (the app's ceiling), never the
    // per-login `scope` (which login()/init() compute independently and may
    // disagree on).
    stubGlobals();
    const CEILING = "atproto rpc:a?aud=* rpc:b?aud=*";
    await login(HANDLE, { scope: BASE, clientIdScope: CEILING });

    expect(clientOpts).toHaveLength(1);
    const { client_id, scope } = clientOpts[0]?.clientMetadata ?? {};
    expect(client_id).toContain(`scope=${encodeURIComponent(CEILING)}`);
    expect(client_id).not.toContain(`scope=${encodeURIComponent(BASE)}`);
    // The local metadata declares the same stable scope the id embeds.
    expect(scope).toBe(CEILING);
  });

  it("keeps the dev loopback client_id invariant across differing per-login scopes", async () => {
    // This is the exact failure mode: login() requests
    // reconcileScope(stored) while init()/restore request SCOPE_SETS.base. When
    // the client id is derived from the per-login scope those two produce
    // DIFFERENT client ids, and the callback's token exchange fails with
    // `invalid_grant: Token was not issued to this client`. With a shared
    // clientIdScope both requests must yield the identical client id.
    stubGlobals();
    const CEILING = "atproto rpc:a?aud=* rpc:b?aud=*";
    await login(HANDLE, { scope: "atproto rpc:a?aud=*", clientIdScope: CEILING });
    await login(HANDLE, { scope: BASE, clientIdScope: CEILING });

    expect(clientOpts).toHaveLength(2);
    const first = clientOpts[0]?.clientMetadata?.client_id;
    const second = clientOpts[1]?.clientMetadata?.client_id;
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("falls back to the per-login scope for clientIdScope when none is given", async () => {
    // SDK consumers that only ever request one scope need no explicit ceiling.
    stubGlobals();
    await login(HANDLE, { scope: BASE });

    expect(clientOpts).toHaveLength(1);
    const { client_id, scope } = clientOpts[0]?.clientMetadata ?? {};
    expect(client_id).toContain(`scope=${encodeURIComponent(BASE)}`);
    expect(scope).toBe(BASE);
  });
});
