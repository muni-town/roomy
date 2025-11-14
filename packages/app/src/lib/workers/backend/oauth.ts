import {
  OAuthClient,
  Key,
  type Session,
  type InternalStateData,
  type OAuthClientMetadataInput,
  type RuntimeLock,
} from "@atproto/oauth-client";
import { Dexie, type EntityTable } from "dexie";
import { JoseKey } from "@atproto/jwk-jose";

// TODO: implement cleanup of old db state and session values?
const db = new Dexie("atproto-oauth") as Dexie & {
  state: EntityTable<{ key: string; data: string }, "key">;
  session: EntityTable<{ key: string; data: Session }, "key">;
  dpopNonce: EntityTable<{ key: string; data: string }, "key">;
};
db.version(1).stores({
  state: `key`,
  session: `key`,
  dpopNonce: `key`,
});

const requestLock: undefined | RuntimeLock = navigator.locks?.request
  ? <T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> =>
      navigator.locks.request(name, { mode: "exclusive" }, async () => fn())
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
        if (algorithm.name.startsWith("sha")) {
          const subtleAlgo = `SHA-${algorithm.name.slice(3)}`;
          const buffer = await crypto.subtle.digest(subtleAlgo, bytes);
          return new Uint8Array(buffer);
        }

        throw new TypeError(`Unsupported algorithm: ${algorithm.name}`);
      },

      requestLock,
    },

    stateStore: {
      async set(key: string, internalState: InternalStateData): Promise<void> {
        const data = {
          ...internalState,
          dpopKey: encodeKey(internalState.dpopKey) as any,
        };
        await db.state.put({
          key,
          data: JSON.stringify(data),
        });
      },
      async get(key: string): Promise<InternalStateData | undefined> {
        const data = JSON.parse((await db.state.get(key))?.data || "undefined");
        if (data) {
          data.dpopKey = await decodeKey(data.dpopKey as any);
        }
        return data;
      },
      async del(key: string): Promise<void> {
        await db.state.delete(key);
      },
    },

    // TODO: Figure out if we need to clear this with some kind of a TTL
    dpopNonceCache: {
      async set(key: string, data): Promise<void> {
        await db.dpopNonce.put({
          key,
          data,
        });
      },
      async get(key: string): Promise<string | undefined> {
        return (await db.dpopNonce.get(key))?.data;
      },
      async del(key: string): Promise<void> {
        await db.dpopNonce.delete(key);
      },
    },

    sessionStore: {
      async set(sub: string, session: Session): Promise<void> {
        await db.session.put({
          key: sub,
          data: { ...session, dpopKey: encodeKey(session.dpopKey) as any },
        });
      },
      async get(sub: string): Promise<Session | undefined> {
        const data = (await db.session.get(sub))?.data;
        if (data) {
          data.dpopKey = await decodeKey(data.dpopKey as any);
        }
        return data;
      },
      async del(sub: string): Promise<void> {
        await db.session.delete(sub);
      },
    },

    fetch,
    allowHttp: true,
  });
