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

vi.mock("@atproto/oauth-client-browser", () => {
  class BrowserOAuthClient {
    static clientMetadata = { redirect_uris: ["https://app.example/"] };
    clientMetadata = BrowserOAuthClient.clientMetadata;
    signIn = signIn;
    authorize = authorize;
    constructor(_opts: unknown) {}
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
});
