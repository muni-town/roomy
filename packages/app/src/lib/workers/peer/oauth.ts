import {
  OAuthClient,
  Key,
  type Session,
  type InternalStateData,
  type OAuthClientMetadataInput,
  type RuntimeLock,
} from "@atproto/oauth-client";
import {
  atprotoLoopbackClientMetadata,
  BrowserOAuthClient,
  buildLoopbackClientId,
} from "@atproto/oauth-client-browser";
import { Dexie, type EntityTable } from "dexie";
import { JoseKey } from "@atproto/jwk-jose";
import { CONFIG, flags } from "$lib/config";

// TODO: implement cleanup of old db state and session values?
export const oauthDb = new Dexie("atproto-oauth") as Dexie & {
  state: EntityTable<{ key: string; data: string }, "key">;
  session: EntityTable<{ key: string; data: Session }, "key">;
  dpopNonce: EntityTable<{ key: string; data: string }, "key">;
};
oauthDb.version(1).stores({
  state: `key`,
  session: `key`,
  dpopNonce: `key`,
});

// Only use locks when SharedWorker is enabled - otherwise each tab has isolated state
const requestLock: RuntimeLock | undefined =
  flags.sharedWorker && navigator.locks?.request
    ? <T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> =>
        navigator.locks.request(name, { mode: "exclusive" }, fn) as Promise<T>
    : undefined;

function encodeKey(key: Key): unknown {
  return (key as any).jwk;
}

async function decodeKey(encoded: unknown): Promise<Key> {
  return JoseKey.fromJWK(encoded as any);
}

export const workerOauthClient = (clientMetadata: OAuthClientMetadataInput) =>
  new OAuthClient({
    handleResolver: "https://resolver.roomy.chat",
    responseMode: "query",
    clientMetadata,

    runtimeImplementation: {
      // A runtime specific implementation of the crypto operations needed by the
      // OAuth client. See "@atproto/oauth-client-browser" for a browser specific
      // implementation. The following example is suitable for use in NodeJS.

      async createKey(algs: string[]): Promise<Key> {
        // TODO: use non-extractable WebcryptoKey instead for greater security.( but more difficult
        // serialization problems when trying to save state in webkit-based browser ). If we change
        // this we need toupdate the key encoding helpers and test on a Webkit based browser.
        const key = await JoseKey.generate(algs);
        return key;
      },

      getRandomValues(length: number): Uint8Array | PromiseLike<Uint8Array> {
        return crypto.getRandomValues(new Uint8Array(length));
      },

      async digest(
        bytes: Uint8Array,
        algorithm: { name: string },
      ): Promise<Uint8Array> {
        // sha256 is required. Unsupported algorithms should throw an error.
        const algoMap: Record<string, string> = {
          sha256: "SHA-256",
          sha384: "SHA-384",
          sha512: "SHA-512",
        };

        const subtleAlgo = algoMap[algorithm.name];
        if (!subtleAlgo) {
          throw new TypeError(`Unsupported algorithm: ${algorithm.name}`);
        }

        // Ensure we have a plain ArrayBuffer-backed Uint8Array
        const buffer = new Uint8Array(bytes).buffer;
        const hash = await crypto.subtle.digest(subtleAlgo, buffer);
        return new Uint8Array(hash);
      },

      requestLock,
    },

    stateStore: {
      async set(key: string, internalState: InternalStateData): Promise<void> {
        const data = {
          ...internalState,
          dpopKey: encodeKey(internalState.dpopKey) as any,
        };
        await oauthDb.state.put({
          key,
          data: JSON.stringify(data),
        });
      },
      async get(key: string): Promise<InternalStateData | undefined> {
        const entry = await oauthDb.state.get(key);
        if (!entry)
          throw new Error("Could not find key in ATProto OAuth iDB: " + key);
        const data = JSON.parse(entry.data || "undefined");
        if (data) {
          data.dpopKey = await decodeKey(data.dpopKey as any);
        }
        return data;
      },
      async del(key: string): Promise<void> {
        await oauthDb.state.delete(key);
      },
    },

    // TODO: Figure out if we need to clear this with some kind of a TTL
    dpopNonceCache: {
      async set(key: string, data): Promise<void> {
        await oauthDb.dpopNonce.put({
          key,
          data,
        });
      },
      async get(key: string): Promise<string | undefined> {
        return (await oauthDb.dpopNonce.get(key))?.data;
      },
      async del(key: string): Promise<void> {
        await oauthDb.dpopNonce.delete(key);
      },
    },

    sessionStore: {
      async set(sub: string, session: Session): Promise<void> {
        await oauthDb.session.put({
          key: sub,
          data: { ...session, dpopKey: encodeKey(session.dpopKey) as any },
        });
      },
      async get(sub: string): Promise<Session | undefined> {
        const data = (await oauthDb.session.get(sub))?.data;
        if (data) {
          data.dpopKey = await decodeKey(data.dpopKey as any);
        }
        return data;
      },
      async del(sub: string): Promise<void> {
        await oauthDb.session.delete(sub);
      },
    },

    fetch,
    allowHttp: true,
  });

export async function createOauthClient(): Promise<OAuthClient> {
  // Build the client metadata
  let clientMetadata: OAuthClientMetadataInput;
  if (import.meta.env.DEV) {
    // Get the base URL and redirect URL for this deployment
    if (globalThis.location.hostname == "localhost")
      throw new Error("hostname must be 127.0.0.1 if local");
    const baseUrl = new URL(`http://127.0.0.1:${globalThis.location.port}`);
    baseUrl.hash = "";
    baseUrl.pathname = "/";
    const redirectUri = baseUrl.href + "oauth/callback";
    // In dev, we build a development metadata
    clientMetadata = {
      ...atprotoLoopbackClientMetadata(buildLoopbackClientId(baseUrl)),
      redirect_uris: [redirectUri],
      scope: CONFIG.atprotoOauthScope,
      client_id: `http://localhost?redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&scope=${encodeURIComponent(CONFIG.atprotoOauthScope)}`,
    };
  } else {
    // In prod, we fetch the `/oauth-client.json` which is expected to be deployed alongside the
    // static build.
    // native client metadata is not reuqired to be on the same domin as client_id,
    // so it can always use the deployed metadata
    const resp = await fetch(`/oauth-client-metadata.json`, {
      headers: [["accept", "application/json"]],
    });
    clientMetadata = await resp.json();
  }

  // If we are in the main thread, then we can return the official browser oauth client
  if (typeof window !== "undefined") {
    return new BrowserOAuthClient({
      clientMetadata,
      handleResolver: "https://resolver.roomy.chat",
      responseMode: "query",
    });
  } else {
    // If we are not on the main thread, return our custom client that works inside of a web worker.
    return workerOauthClient(clientMetadata);
  }
}
