/**
 * Tests for the return-URL store that replaced the OAuth `state` transport.
 *
 * The contract: the page path survives the round-trip out to the PDS and back
 * via `sessionStorage`, is consumed exactly once, never becomes an off-origin
 * navigation target, and the callback predicate matches what the OAuth clients
 * themselves treat as a callback (so app-lite decides "was this a callback?"
 * independently of the client that is about to rewrite the address bar).
 *
 * Run with the package's Node test runner (`node --test`); the module is
 * storage-injected so no DOM is required.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  RETURN_URL_KEY,
  consumeReturnUrl,
  hasOAuthCallbackParams,
  rememberReturnUrl,
  safeReturnUrl,
} from "./return-url.ts";
import type { ReturnUrlStorage } from "./return-url.ts";

/** An in-memory `Storage`, complete so it needs no cast to stand in for one. */
function memoryStorage(): ReturnUrlStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value),
  };
}

describe("remember/consume", () => {
  test("the return URL survives the round-trip and lands the user back", () => {
    const storage = memoryStorage();
    // User is on a deep page (a room) when they hit sign in.
    rememberReturnUrl("/space/1/channel/abc?tab=threads#msg-9", storage);

    // The PDS sends them to the fixed redirect URI, then the app navigates.
    assert.equal(
      consumeReturnUrl("/", storage),
      "/space/1/channel/abc?tab=threads#msg-9",
    );
  });

  test("consuming clears the entry, so it never replays on the next load", () => {
    const storage = memoryStorage();
    rememberReturnUrl("/space/1", storage);

    assert.equal(consumeReturnUrl("/", storage), "/space/1");
    assert.equal(consumeReturnUrl("/", storage), null);
  });

  test("a target equal to the current page needs no navigation", () => {
    const storage = memoryStorage();
    rememberReturnUrl("/", storage);

    assert.equal(consumeReturnUrl("/", storage), null);
  });

  test("an unset store reads as null rather than throwing", () => {
    assert.equal(consumeReturnUrl("/", null), null);
  });

  test("a null store makes remembering a no-op", () => {
    // SSR / non-DOM environments: never throws.
    rememberReturnUrl("/space/1", null);
  });
});

describe("safeReturnUrl", () => {
  test("accepts a root-relative path with query and hash", () => {
    assert.equal(safeReturnUrl("/space/1?a=b#c"), "/space/1?a=b#c");
  });

  for (const bad of [
    "https://evil.example",
    "//evil.example",
    "javascript:alert(1)",
    "",
    "space/1",
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(safeReturnUrl(bad), null);
    });
  }

  test("rejects non-strings", () => {
    assert.equal(safeReturnUrl(undefined), null);
    assert.equal(safeReturnUrl(null), null);
    assert.equal(safeReturnUrl(7), null);
  });

  test("an off-origin stored value is never navigated to", () => {
    const storage = memoryStorage();
    // Simulate a crafted store (the value is not reachable from a callback
    // URL today, but the store is the one place a target can arrive from).
    storage.setItem(RETURN_URL_KEY, "https://evil.example/phish");

    assert.equal(consumeReturnUrl("/", storage), null);
    // Still consumed, so a poisoned entry cannot persist.
    assert.equal(storage.getItem(RETURN_URL_KEY), null);
  });
});

describe("hasOAuthCallbackParams", () => {
  test("true for a code callback", () => {
    assert.equal(hasOAuthCallbackParams("?state=abc123&code=xyz"), true);
  });

  test("true for an error callback", () => {
    assert.equal(
      hasOAuthCallbackParams("?state=abc123&error=access_denied"),
      true,
    );
  });

  test("false without a state", () => {
    assert.equal(hasOAuthCallbackParams("?code=xyz"), false);
  });

  test("false without a code or error", () => {
    assert.equal(hasOAuthCallbackParams("?state=abc123"), false);
  });

  test("false for an ordinary page load", () => {
    assert.equal(hasOAuthCallbackParams("?tab=threads"), false);
    assert.equal(hasOAuthCallbackParams(""), false);
  });
});
