/**
 * The session's native copy, against the five things it must do.
 *
 * The client's own store is a fake here on purpose: the ordering this module
 * enforces (seed before `init()`) and the client's behaviour on a missing or
 * broken session are what decide whether a launch restores, and neither needs
 * IndexedDB to be observable. The *key* is real — a real `CryptoKeyPair` from
 * Node's WebCrypto, exported and re-imported — because that is the part the
 * whole design turns on: a session copied into a JSON store without a usable
 * private key restores a user who cannot sign a request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserOAuthClient,
  WebcryptoKey,
  type Session,
  type SessionStore,
} from "@atproto/oauth-client-browser";
import type { TauriStoreLike } from "./tauri-store-persister";
import {
  NATIVE_AUTH_DIAGNOSTIC_KEY,
  NATIVE_SESSION_KEY,
  NativeSessionMirror,
  clientSessionStore,
  fromSnapshot,
  readAuthDiagnostic,
  restoreNativeSession,
  toSnapshot,
  type NativeSessionClient,
} from "./native-session";

const SUB = "did:plc:abcdefghijklmnopqrstuvwx";

/** A session whose key pair is a real, extractable WebCrypto pair. */
async function makeSession(): Promise<Session> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    dpopKey: await WebcryptoKey.fromKeypair(pair, "kid-1"),
    authMethod: { method: "none" },
    tokenSet: {
      iss: "https://pds.test",
      sub: SUB,
      aud: "https://pds.test",
      scope: "atproto",
      access_token: "access-token-1",
      refresh_token: "refresh-token-1",
      token_type: "DPoP",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  } as unknown as Session;
}

/**
 * The shell's store. Values go through JSON in both directions, as the plugin's
 * do, so anything that only survives a structured clone fails here.
 */
class FakeStore implements TauriStoreLike {
  readonly data = new Map<string, unknown>();
  /** Every mutation, in order. */
  readonly writes: string[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.writes.push(key);
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }

  async delete(key: string): Promise<boolean> {
    this.writes.push(`delete:${key}`);
    return this.data.delete(key);
  }

  async save(): Promise<void> {
    this.writes.push("save");
  }
}

/** A client recording the order the session store and `init()` are reached in. */
function fakeClient(
  events: string[],
  onInit?: (seeded: Session | undefined) => { session: unknown } | undefined,
) {
  const seeded = new Map<string, Session>();
  const sessionStore: SessionStore = {
    get: async (key) => {
      events.push(`get:${key}`);
      return seeded.get(key);
    },
    set: async (key, value) => {
      events.push(`set:${key}`);
      seeded.set(key, value);
    },
    del: async (key) => {
      events.push(`del:${key}`);
      seeded.delete(key);
    },
  };
  const client: NativeSessionClient = {
    init: async () => {
      events.push("init");
      return onInit?.(seeded.get(SUB)) as
        | { session: never }
        | undefined;
    },
    restore: async (sub) => {
      events.push(`restore:${sub}`);
      const session = seeded.get(sub);
      if (!session) throw new TypeError("no session");
      return session as never;
    },
  };
  return { client, sessionStore };
}

describe("the session snapshot", () => {
  it("round-trips a real DPoP key pair through JSON", async () => {
    const session = await makeSession();
    const snapshot = await toSnapshot(SUB, session);

    // The plugin writes JSON, so a snapshot that survives `JSON.parse` is the
    // only one that can come back.
    const restored = await fromSnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(restored.tokenSet).toEqual(session.tokenSet);
    expect(restored.authMethod).toEqual({ method: "none" });

    const key = restored.dpopKey as WebcryptoKey;
    expect(key.kid).toBe("kid-1");
    expect(key.alg).toBe("ES256");

    const proof = new TextEncoder().encode("dpop-proof");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.cryptoKeyPair.privateKey,
      proof,
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key.cryptoKeyPair.publicKey,
        signature,
        proof,
      ),
    ).toBe(true);

    // Restored keys stay exportable, or a token refresh would save a snapshot
    // the next launch could not restore.
    await expect(toSnapshot(SUB, restored)).resolves.toBeTruthy();
  });
});

describe("restoring through the mirror", () => {
  it("seeds the client's session store with the stored sub before init() runs", async () => {
    const store = new FakeStore();
    await store.set(NATIVE_SESSION_KEY, await toSnapshot(SUB, await makeSession()));
    const mirror = new NativeSessionMirror({ store });

    const events: string[] = [];
    const { client, sessionStore } = fakeClient(events, (seeded) => {
      // The seed is what `init()` restores: without it this launch is cold.
      expect(seeded?.tokenSet.sub).toBe(SUB);
      return { session: { sub: SUB } };
    });

    const result = await restoreNativeSession(client, sessionStore, mirror);

    expect(events).toEqual([`set:${SUB}`, "init"]);
    expect(result?.session).toEqual({ sub: SUB });
  });

  it("starts cold when the store holds no snapshot", async () => {
    const store = new FakeStore();
    const mirror = new NativeSessionMirror({ store });

    const events: string[] = [];
    const { client, sessionStore } = fakeClient(events);

    await expect(
      restoreNativeSession(client, sessionStore, mirror),
    ).resolves.toBeUndefined();
    // Nothing seeded: `init()` alone, as without the mirror. The launch's
    // diagnostic is written, the session is not.
    expect(events).toEqual(["init"]);
    expect(store.data.has(NATIVE_SESSION_KEY)).toBe(false);
  });

  it("discards a corrupt snapshot and starts cold", async () => {
    const store = new FakeStore();
    store.data.set(NATIVE_SESSION_KEY, { version: 1, sub: SUB });
    const mirror = new NativeSessionMirror({ store });

    const events: string[] = [];
    const { client, sessionStore } = fakeClient(events);

    await expect(
      restoreNativeSession(client, sessionStore, mirror),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["init"]);
    expect(store.data.has(NATIVE_SESSION_KEY)).toBe(false);
  });

  it("discards a snapshot whose key cannot be imported and starts cold", async () => {
    const store = new FakeStore();
    const snapshot = await toSnapshot(SUB, await makeSession());
    store.data.set(NATIVE_SESSION_KEY, {
      ...snapshot,
      dpopKey: { ...snapshot.dpopKey, privateJwk: { kty: "EC" } },
    });
    const mirror = new NativeSessionMirror({ store });

    const events: string[] = [];
    const { client, sessionStore } = fakeClient(events);

    await expect(
      restoreNativeSession(client, sessionStore, mirror),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["init"]);
    expect(store.data.has(NATIVE_SESSION_KEY)).toBe(false);
  });

  it("restores directly when init() has no recorded sub to look up", async () => {
    const store = new FakeStore();
    await store.set(NATIVE_SESSION_KEY, await toSnapshot(SUB, await makeSession()));
    const mirror = new NativeSessionMirror({ store });

    // `init()` returning nothing is the evicted-webview case: the client's own
    // record of which sub to restore went with the IndexedDB.
    const events: string[] = [];
    const { client, sessionStore } = fakeClient(events);

    const result = await restoreNativeSession(client, sessionStore, mirror);

    expect(events).toEqual([`set:${SUB}`, "init", `restore:${SUB}`]);
    expect((result?.session as unknown as Session).tokenSet.sub).toBe(SUB);
  });

  it("starts cold when the client's session store cannot be reached", async () => {
    const mirror = new NativeSessionMirror({ store: new FakeStore() });
    const events: string[] = [];
    const { client } = fakeClient(events);

    await expect(
      restoreNativeSession(client, null, mirror),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["init"]);
    // The handle itself degrades rather than throwing: a dependency that moved
    // the getter must not be able to fail a launch.
    expect(clientSessionStore({})).toBeNull();
  });

  it("removes the snapshot on sign-out, so the next launch has nothing to restore", async () => {
    const store = new FakeStore();
    await store.set(NATIVE_SESSION_KEY, await toSnapshot(SUB, await makeSession()));
    const mirror = new NativeSessionMirror({ store });
    expect(await mirror.load()).not.toBeNull();

    await mirror.hooks.onDelete(SUB);

    expect(store.data.has(NATIVE_SESSION_KEY)).toBe(false);
    expect(await mirror.load()).toBeNull();

    const events: string[] = [];
    const { client, sessionStore } = fakeClient(events);
    await expect(
      restoreNativeSession(client, sessionStore, mirror),
    ).resolves.toBeUndefined();
    expect(events).toEqual(["init"]);
  });
});

describe("without a native store", () => {
  it("writes nothing and leaves the client's own restore path alone", async () => {
    for (const store of [null, undefined]) {
      const mirror = new NativeSessionMirror({ store });
      expect(mirror.available).toBe(false);

      // The hooks are the client's callbacks; off the shell they must be inert.
      await expect(
        mirror.hooks.onUpdate(SUB, await makeSession()),
      ).resolves.toBeUndefined();
      await expect(mirror.hooks.onDelete(SUB)).resolves.toBeUndefined();
      expect(await mirror.load()).toBeNull();

      const events: string[] = [];
      const { client, sessionStore } = fakeClient(events);
      await expect(
      restoreNativeSession(client, sessionStore, mirror),
    ).resolves.toBeUndefined();
      expect(events).toEqual(["init"]);
    }
  });
});

describe("the startup line", () => {
  it("names the three facts that separate the two ways a launch is signed out", async () => {
    const lines: string[] = [];
    const store = new FakeStore();
    const mirror = new NativeSessionMirror({
      store,
      onDiagnostic: (message) => lines.push(message),
    });

    await mirror.load();
    await mirror.reportStartup({ session: false });

    await store.set(NATIVE_SESSION_KEY, await toSnapshot(SUB, await makeSession()));
    await mirror.load();
    await mirror.reportStartup({
      session: false,
      error: new DOMException("token expired", "TokenRefreshError"),
    });

    expect(lines).toEqual([
      "auth: session present=no native snapshot=no init error=none",
      "auth: session present=no native snapshot=yes init error=TokenRefreshError",
    ]);
  });
});

describe("the launch record", () => {
  it("keeps the launch's facts under its own key, with nothing from the session", async () => {
    const store = new FakeStore();
    await store.set(NATIVE_SESSION_KEY, await toSnapshot(SUB, await makeSession()));
    const mirror = new NativeSessionMirror({ store });

    const events: string[] = [];
    const { client, sessionStore } = fakeClient(events, () => ({
      session: { sub: SUB },
    }));

    await restoreNativeSession(client, sessionStore, mirror);

    const record = await readAuthDiagnostic(store);
    expect(record).toMatchObject({
      session: true,
      nativeSnapshot: true,
      initError: null,
    });
    expect(typeof record?.at).toBe("string");
    // The record's whole shape: a tester can paste it anywhere.
    expect(
      Object.keys(store.data.get(NATIVE_AUTH_DIAGNOSTIC_KEY) as object).sort(),
    ).toEqual(["at", "initError", "nativeSnapshot", "session", "version"]);
  });

  it("names the error that stopped a restore, and still rejects", async () => {
    const store = new FakeStore();
    const mirror = new NativeSessionMirror({ store });
    const events: string[] = [];
    const { client, sessionStore } = fakeClient(events);
    client.init = async () => {
      throw new DOMException("token expired", "TokenRefreshError");
    };

    await expect(
      restoreNativeSession(client, sessionStore, mirror),
    ).rejects.toThrow("token expired");

    expect(await readAuthDiagnostic(store)).toMatchObject({
      session: false,
      nativeSnapshot: false,
      initError: "TokenRefreshError",
    });
  });

  it("outlives the sign-out that deletes the session", async () => {
    const store = new FakeStore();
    await store.set(NATIVE_SESSION_KEY, await toSnapshot(SUB, await makeSession()));
    const mirror = new NativeSessionMirror({ store });

    await mirror.load();
    await mirror.reportStartup({ session: true });
    await mirror.hooks.onDelete(SUB);

    expect(store.data.has(NATIVE_SESSION_KEY)).toBe(false);
    expect(await readAuthDiagnostic(store)).toMatchObject({
      session: true,
      nativeSnapshot: true,
    });
  });

  it("reads nothing from a store without a usable record", async () => {
    expect(await readAuthDiagnostic(null)).toBeNull();
    expect(await readAuthDiagnostic(new FakeStore())).toBeNull();

    const corrupt = new FakeStore();
    corrupt.data.set(NATIVE_AUTH_DIAGNOSTIC_KEY, { version: 1 });
    expect(await readAuthDiagnostic(corrupt)).toBeNull();
  });
});

describe("the client's own store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is reachable on a real client, which is the store the seed has to reach", () => {
    // The client opens its IndexedDB eagerly in the constructor and reads
    // `localStorage` when it restores; nothing is opened or read here beyond
    // the store handle itself.
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
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });

    const client = new BrowserOAuthClient({
      // Neither is called: the handle is never resolved here.
      handleResolver: { resolve: async () => null } as never,
      clientMetadata: {
        client_id: "http://localhost",
        redirect_uris: ["http://127.0.0.1:5199/"],
        scope: "atproto",
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        dpop_bound_access_tokens: true,
      },
    });

    const store = clientSessionStore(client);
    expect(store !== null && typeof store.set === "function").toBe(true);
    expect(store !== null && typeof store.get === "function").toBe(true);
    expect(store !== null && typeof store.del === "function").toBe(true);
  });
});
