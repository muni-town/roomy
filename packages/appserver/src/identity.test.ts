/**
 * The DID-document cache is the appserver's only back-pressure on a did:web
 * host, so what matters here is the fetch count it produces. These tests count
 * real outbound fetches through a stubbed global `fetch` instead of trusting
 * the code path.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { IdResolver, type DidDocument } from "@atproto/identity";
import { createServiceJwt } from "@atproto/xrpc-server";
import { ResilientDidCache, resolvePdsEndpoint } from "./identity.ts";
import { prodAuthVerifier } from "./xrpc/auth.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const DID = "did:web:did-cache.test";
const DID_HOST = "did-cache.test";
const AUTH_DID = "did:web:did-cache-auth.test";
const AUTH_HOST = "did-cache-auth.test";
const PDS = "https://pds.test";
const ROTATED_PDS = "https://pds-rotated.test";

/** Revalidation window and hard bound for the resolvers built per test. */
const STALE_MS = 10 * MINUTE;
const MAX_MS = HOUR;

const realFetch = globalThis.fetch;

/** Every outbound host hit, in order — the number these tests are about. */
let fetched: string[] = [];
/** What the "host" serves: the PDS its documents point at, and whether it answers. */
let servedPds = PDS;
let mode: "ok" | "http-error" | "network-error" = "ok";
/** Signing key published for `AUTH_DID`, when a test verifies tokens. */
let publishedKey: string | null = null;

function documentFor(did: string, pds: string): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: did,
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: pds,
      },
    ],
  };
  if (publishedKey) {
    doc.verificationMethod = [
      {
        id: "#atproto",
        type: "Multikey",
        controller: did,
        publicKeyMultibase: publishedKey,
      },
    ];
  }
  return doc;
}

function pdsEndpointOf(doc: DidDocument | null): unknown {
  const service = doc?.service?.find((s) => s.id === "#atproto_pds");
  return service?.serviceEndpoint;
}

function directResolver(): IdResolver {
  return new IdResolver({
    didCache: new ResilientDidCache(STALE_MS, MAX_MS),
  });
}

beforeEach(() => {
  fetched = [];
  servedPds = PDS;
  mode = "ok";
  publishedKey = null;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname !== "/.well-known/did.json") {
      throw new Error(`unexpected outbound fetch: ${url}`);
    }
    fetched.push(url.hostname);
    if (mode === "network-error") {
      return Promise.reject(new Error("host unreachable"));
    }
    if (mode === "http-error") {
      return Promise.resolve(new Response("nope", { status: 500 }));
    }
    const did = `did:web:${url.hostname}`;
    return Promise.resolve(Response.json(documentFor(did, servedPds)));
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

describe("shared DID-document cache", () => {
  test("one fetch serves every resolution that shares the cache", async () => {
    // Two resolvers over one cache is the appserver's shape: JWT verification,
    // the blob proxy and profile fetches all resolve through identity.ts.
    const didCache = new ResilientDidCache(STALE_MS, MAX_MS);
    const identityResolver = new IdResolver({ didCache });
    const authResolver = new IdResolver({ didCache });

    for (let i = 0; i < 20; i++) {
      const resolver = i % 2 === 0 ? identityResolver : authResolver;
      expect(pdsEndpointOf(await resolver.did.resolve(DID))).toBe(PDS);
    }

    expect(fetched).toEqual([DID_HOST]);
  });

  test("re-fetches only after the revalidation window", async () => {
    const resolver = directResolver();

    await resolver.did.resolve(DID);
    setSystemTime(Date.now() + STALE_MS - MINUTE);
    await resolver.did.resolve(DID);

    expect(fetched.length).toBe(1);
  });

  test("picks up a rotated document within the revalidation window", async () => {
    const resolver = directResolver();
    await resolver.did.resolve(DID);

    setSystemTime(Date.now() + STALE_MS + MINUTE);
    servedPds = ROTATED_PDS;

    // The resolution that trips the window revalidates and still returns the
    // cached document (stale-while-revalidate).
    expect(pdsEndpointOf(await resolver.did.resolve(DID))).toBe(PDS);
    expect(fetched.length).toBe(2);

    // Every resolution after it serves the rotated document, for free.
    expect(pdsEndpointOf(await resolver.did.resolve(DID))).toBe(ROTATED_PDS);
    expect(fetched.length).toBe(2);
  });

  test("keeps serving the last known document when revalidation fails", async () => {
    const resolver = directResolver();
    await resolver.did.resolve(DID);

    setSystemTime(Date.now() + STALE_MS + MINUTE);
    mode = "http-error";
    expect(pdsEndpointOf(await resolver.did.resolve(DID))).toBe(PDS);
    expect(fetched.length).toBe(2);

    // One revalidation attempt per window, not one per request.
    for (let i = 0; i < 10; i++) {
      expect(pdsEndpointOf(await resolver.did.resolve(DID))).toBe(PDS);
    }
    expect(fetched.length).toBe(2);

    // An unreachable host is not an error for the caller either.
    mode = "network-error";
    setSystemTime(Date.now() + STALE_MS + MINUTE);
    expect(pdsEndpointOf(await resolver.did.resolve(DID))).toBe(PDS);
    expect(fetched.length).toBe(3);
  });

  test("does not serve a document past the hard bound", async () => {
    const resolver = directResolver();
    await resolver.did.resolve(DID);

    setSystemTime(Date.now() + MAX_MS + MINUTE);
    mode = "http-error";

    expect(await resolver.did.resolve(DID)).toBeNull();
    expect(fetched.length).toBe(2);
  });
});

describe("appserver resolver defaults", () => {
  test("half an hour of PDS resolutions costs one fetch", async () => {
    expect(await resolvePdsEndpoint(DID)).toBe(PDS);

    setSystemTime(Date.now() + 30 * MINUTE);
    expect(await resolvePdsEndpoint(DID)).toBe(PDS);
    expect(fetched).toEqual([DID_HOST]);

    // Past the hard bound a resolution fetches again and sees the rotation.
    setSystemTime(Date.now() + 25 * HOUR);
    servedPds = ROTATED_PDS;
    await resolvePdsEndpoint(DID);
    expect(await resolvePdsEndpoint(DID)).toBe(ROTATED_PDS);
    expect(fetched.length).toBe(2);
  });
});

describe("session-JWT verification", () => {
  test("resolves the issuer's document once for many tokens", async () => {
    const keypair = await Secp256k1Keypair.create();
    publishedKey = keypair.did().slice("did:key:".length);
    const audience = process.env.APPSERVER_DID ?? "did:web:api.roomy.space";
    const jwt = await createServiceJwt({
      iss: AUTH_DID,
      aud: audience,
      keypair,
      lxm: "space.roomy.space.getSpaces",
    });
    const request = () =>
      new Request("https://appserver.test/xrpc/space.roomy.space.getSpaces", {
        headers: { authorization: `Bearer ${jwt}` },
      });

    expect(await prodAuthVerifier(request())).toEqual({ did: AUTH_DID });
    expect(await prodAuthVerifier(request())).toEqual({ did: AUTH_DID });

    // Two verifications, one document fetch: the verifier shares identity.ts's
    // cache — a private cache here would have fetched twice.
    expect(fetched).toEqual([AUTH_HOST]);
  });
});
