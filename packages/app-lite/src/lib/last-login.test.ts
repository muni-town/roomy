/**
 * Tests for the "Previously signed in as" record.
 *
 * The record stores a `handle` snapshot. Offering it without re-checking would
 * name a handle that no longer resolves after a rename, and clicking it would
 * fail with "Failed to resolve identity: <handle>".
 *
 * These tests pin the contract that prevents that: a handle is offered only when
 * the stored DID's live handle matches it (or has been repaired from it).
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the file
 * runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  LAST_LOGIN_KEY,
  decideLastLogin,
  parseLastLogin,
  verifyLastLogin,
  type LastLogin,
  type LastLoginStorage,
} from "./last-login.ts";

const DID = "did:plc:uzi5qarfn75i6txjbqidz2wc";

const stored: LastLogin = {
  handle: "example-old.roomy.chat",
  did: DID,
  avatar: "atblob://did:plc:x/y",
  displayName: "Example",
};

function fakeStorage(initial?: LastLogin): LastLoginStorage & {
  value: () => string | null;
} {
  let raw: string | null = initial ? JSON.stringify(initial) : null;
  return {
    getItem: (key) => (key === LAST_LOGIN_KEY ? raw : null),
    setItem: (key, value) => {
      if (key === LAST_LOGIN_KEY) raw = value;
    },
    removeItem: (key) => {
      if (key === LAST_LOGIN_KEY) raw = null;
    },
    value: () => raw,
  };
}

/** A `fetch` that answers every profile lookup with `body` at `status`. */
function stubFetch(status: number, body?: unknown): typeof fetch {
  return (async () =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("parseLastLogin", () => {
  test("rejects the handle.invalid sentinel", () => {
    assert.equal(
      parseLastLogin(JSON.stringify({ ...stored, handle: "handle.invalid" })),
      null,
    );
  });

  test("rejects records with no usable handle or DID", () => {
    assert.equal(parseLastLogin(JSON.stringify({ ...stored, handle: "" })), null);
    assert.equal(parseLastLogin(JSON.stringify({ ...stored, did: "" })), null);
    assert.equal(parseLastLogin(JSON.stringify({ handle: "a.b" })), null);
    assert.equal(parseLastLogin("not json"), null);
    assert.equal(parseLastLogin(null), null);
  });

  test("keeps a well-formed record", () => {
    assert.deepEqual(parseLastLogin(JSON.stringify(stored)), stored);
  });
});

describe("decideLastLogin", () => {
  test("repairs a handle that no longer resolves to its DID", () => {
    const decision = decideLastLogin(stored, "example-new.roomy.chat");
    assert.equal(decision.record?.handle, "example-new.roomy.chat");
    assert.equal(decision.persist?.handle, "example-new.roomy.chat");
    // Identity fields survive the repair — only the handle was stale.
    assert.equal(decision.record?.did, DID);
    assert.equal(decision.record?.avatar, stored.avatar);
  });

  test("offers the stored record unchanged when the handle still matches", () => {
    const decision = decideLastLogin(stored, stored.handle);
    assert.deepEqual(decision.record, stored);
    assert.equal(decision.persist, null);
    assert.equal(decision.remove, false);
  });

  test("removes the record when the DID has no usable handle", () => {
    assert.equal(decideLastLogin(stored, null).remove, true);
    assert.equal(decideLastLogin(stored, null).record, null);
  });

  test("withholds an unverifiable record without deleting it", () => {
    const decision = decideLastLogin(stored, undefined);
    assert.equal(decision.record, null);
    assert.equal(decision.remove, false);
    assert.equal(decision.persist, null);
  });

  test("offers nothing when no record is stored", () => {
    assert.equal(decideLastLogin(null, DID).record, null);
  });
});

describe("verifyLastLogin", () => {
  test("never returns a stale handle as offerable", async () => {
    const storage = fakeStorage(stored);
    const offered = await verifyLastLogin({
      storage,
      fetch: stubFetch(200, { did: DID, handle: "example-new.roomy.chat" }),
    });
    assert.equal(offered?.handle, "example-new.roomy.chat");
    assert.equal(
      JSON.parse(storage.value() ?? "{}").handle,
      "example-new.roomy.chat",
    );
  });

  test("a legitimate record is still offered unchanged", async () => {
    const storage = fakeStorage(stored);
    const offered = await verifyLastLogin({
      storage,
      fetch: stubFetch(200, { did: DID, handle: stored.handle }),
    });
    assert.deepEqual(offered, stored);
    assert.deepEqual(JSON.parse(storage.value() ?? "{}"), stored);
  });

  test("drops the record when the DID no longer has a handle", async () => {
    const storage = fakeStorage(stored);
    const offered = await verifyLastLogin({
      storage,
      fetch: stubFetch(400, { error: "InvalidRequest" }),
    });
    assert.equal(offered, null);
    assert.equal(storage.value(), null);
  });

  test("withholds but keeps the record when the check fails", async () => {
    const storage = fakeStorage(stored);
    const offered = await verifyLastLogin({
      storage,
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    assert.equal(offered, null);
    assert.notEqual(storage.value(), null);
  });

  test("withholds but keeps the record on an inconclusive appview error", async () => {
    const storage = fakeStorage(stored);
    const offered = await verifyLastLogin({ storage, fetch: stubFetch(500) });
    assert.equal(offered, null);
    assert.notEqual(storage.value(), null);
  });

  test("treats the handle.invalid sentinel as no handle", async () => {
    const storage = fakeStorage(stored);
    const offered = await verifyLastLogin({
      storage,
      fetch: stubFetch(200, { did: DID, handle: "handle.invalid" }),
    });
    assert.equal(offered, null);
    assert.equal(storage.value(), null);
  });

  test("no-ops without storage (SSR)", async () => {
    assert.equal(await verifyLastLogin({ storage: null }), null);
  });
});
