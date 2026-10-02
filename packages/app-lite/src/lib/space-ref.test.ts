/**
 * Regression tests for URL space-reference resolution.
 *
 * The bug: `/join/<handle>` (or `/join?space=<handle>`) passed the raw URL
 * segment into `getMetadata`, which expects a DID. The appserver answered
 * `404 Space not found: home` for a *handle* it was never asked to resolve —
 * 134 such lines in 4 days — and the user got an XRPC error instead of a
 * not-found state. These tests pin the rule that replaces it: a reference is
 * either already a DID (pass through), a handle (resolve through the Leaf
 * resolver), or nothing resolvable (a clean not-found, with no request).
 *
 * Written against `node:test` + `node:assert` so the file runs under both
 * `bun test` and `node --test --experimental-strip-types` — app-lite ships no
 * test runner of its own.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isResolvableHandle,
  isSpaceId,
  resolveSpaceHandle,
  resolveSpaceRef,
} from "./space-ref.ts";

const SPACE = "did:plc:ik6zkolq2vtq77lxsi65dcfq";
const OTHER = "did:plc:cyqufxsezk33hqulcilckna6";

/** Install a fetch stub, recording every URL requested. */
function stubFetch(
  handler: (url: URL) => { ok: boolean; body: unknown },
): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const { ok, body } = handler(url);
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { urls };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("space reference classification", () => {
  test("a DID is a space id and needs no resolution", () => {
    assert.equal(isSpaceId(SPACE), true);
    assert.equal(isSpaceId("did:web:api.roomy.space"), true);
  });

  test("handles and bare words are not space ids", () => {
    // The values actually seen in the logs — all reached an id-expecting param.
    for (const value of [
      "atmosphereconf.org",
      "blento.app",
      "the-xanadu-dream",
      "home",
      "watch",
      "[object Object]",
      "",
    ]) {
      assert.equal(isSpaceId(value), false, `${value} must not read as a DID`);
    }
  });

  test("only handle-shaped references are worth resolving", () => {
    assert.equal(isResolvableHandle("atmosphereconf.org"), true);
    assert.equal(isResolvableHandle("muni-town.net"), true);
    // A bare word names no domain to look up.
    assert.equal(isResolvableHandle("home"), false);
    assert.equal(isResolvableHandle("the-xanadu-dream"), false);
    // A stringified object must never reach a resolver as a handle.
    assert.equal(isResolvableHandle("[object Object]"), false);
  });
});

describe("resolveSpaceRef", () => {
  test("passes a DID through without any request", async () => {
    const { urls } = stubFetch(() => ({ ok: true, body: { did: OTHER } }));
    assert.equal(await resolveSpaceRef(SPACE), SPACE);
    assert.deepEqual(urls, []);
  });

  test("resolves a handle to the space's DID", async () => {
    const { urls } = stubFetch(() => ({ ok: true, body: { did: SPACE } }));
    assert.equal(await resolveSpaceRef("atmosphereconf.org"), SPACE);
    assert.equal(urls.length, 1);
    assert.equal(new URL(urls[0]!).searchParams.get("handle"), "atmosphereconf.org");
  });

  test("a bare word is a not-found with no request", async () => {
    const { urls } = stubFetch(() => ({ ok: true, body: { did: SPACE } }));
    assert.equal(await resolveSpaceRef("home"), null);
    assert.deepEqual(urls, []);
  });

  test("an ATProto account DID is not accepted as a space id", async () => {
    // The ATProto handle answer for a space handle is the domain owner's own
    // account, not the space. A resolver reply that is not a DID is dropped
    // rather than sent onward as a spaceId.
    const { urls } = stubFetch(() => ({ ok: true, body: { did: "not-a-did" } }));
    assert.equal(await resolveSpaceRef("atmosphereconf.org"), null);
    assert.equal(urls.length, 1);
  });

  test("an unknown handle resolves to null", async () => {
    // The resolver answers 500 with a `{status, error}` body for a handle with
    // no Leaf record — observed for `home`, `blento.app`, `muni-town.net`.
    stubFetch(() => ({ ok: false, body: { status: 500, error: "NotFound" } }));
    assert.equal(await resolveSpaceRef("blento.app"), null);
  });

  test("a transport failure resolves to null instead of throwing", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    assert.equal(await resolveSpaceRef("atmosphereconf.org"), null);
  });
});

describe("resolveSpaceHandle", () => {
  test("returns null when the resolver answers without a DID", async () => {
    stubFetch(() => ({ ok: true, body: {} }));
    assert.equal(await resolveSpaceHandle("example.com"), null);
  });

  test("encodes the handle so it stays one parameter value", async () => {
    const { urls } = stubFetch(() => ({ ok: true, body: { did: SPACE } }));
    await resolveSpaceHandle("weird.example.com");
    assert.equal(new URL(urls[0]!).searchParams.get("handle"), "weird.example.com");
  });
});
