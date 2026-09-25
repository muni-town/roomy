/**
 * Tests for shareable-link origins.
 *
 * `location.origin` in the Tauri desktop app is `tauri://localhost`, so links
 * built from it could not be opened by anyone else. These tests pin the rule:
 * links are rooted at the public web origin unless the document *is* the public
 * web deployment.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the file
 * runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  inviteUrl,
  isPublicWebDocument,
  resolveShareOrigin,
  shareUrl,
} from "./share-url.ts";

const PUBLIC_ORIGIN = "https://roomy.space";
const Tauri = "tauri://localhost";
const SPACE = "did:plc:drzgt2m6lmcel62gfbzjeap3";
const TOKEN = "invite-token";

describe("resolveShareOrigin", () => {
  test("uses the public web origin in the desktop app", () => {
    // The webview document origin must not reach the link.
    assert.equal(
      resolveShareOrigin(PUBLIC_ORIGIN, Tauri, null),
      PUBLIC_ORIGIN,
    );
  });

  test("uses the public web origin for a build served from anywhere else", () => {
    // A static build served locally has a real web origin, but it is not the
    // deployment the links are for; only the marker says otherwise.
    assert.equal(
      resolveShareOrigin(PUBLIC_ORIGIN, "http://127.0.0.1:5180", null),
      PUBLIC_ORIGIN,
    );
  });

  test("uses the document origin when it is the marked public deployment", () => {
    // A self-hosted deployment links to itself, not to roomy.space.
    assert.equal(
      resolveShareOrigin(
        "https://roomy.example",
        "https://roomy.example",
        "https://roomy.example",
      ),
      "https://roomy.example",
    );
  });

  test("ignores a marker that does not match the document", () => {
    // The desktop bundle carries no marker; a mismatched one is equally
    // untrustworthy — a document may not claim to be a deployment it isn't.
    assert.equal(
      resolveShareOrigin(PUBLIC_ORIGIN, Tauri, PUBLIC_ORIGIN),
      PUBLIC_ORIGIN,
    );
  });

  test("falls back to the document origin for a malformed configured origin", () => {
    // `VITE_PUBLIC_WEB_ORIGIN=roomy.space` (no scheme) must not throw in a
    // link builder — the app keeps working on the origin it actually has.
    assert.equal(resolveShareOrigin("roomy.space", Tauri, null), Tauri);
    assert.equal(resolveShareOrigin("", Tauri, null), Tauri);
  });
});

describe("isPublicWebDocument", () => {
  test("no marker never identifies the document as the web deployment", () => {
    assert.equal(isPublicWebDocument("http://localhost:5180", null), false);
  });
});

describe("inviteUrl", () => {
  test("roots an invite link at the public origin from the desktop app", () => {
    const origin = resolveShareOrigin(PUBLIC_ORIGIN, Tauri, null);
    const url = new URL(inviteUrl(origin, SPACE, TOKEN));
    assert.equal(url.origin, PUBLIC_ORIGIN);
    assert.equal(url.pathname, "/join");
    assert.equal(url.searchParams.get("space"), SPACE);
    assert.equal(url.searchParams.get("invite"), TOKEN);
  });

  test("encodes parameters that would otherwise change the link's meaning", () => {
    // `&`/`=` in a token must stay inside the parameter value.
    const url = new URL(inviteUrl(PUBLIC_ORIGIN, SPACE, "a&invite=b"));
    assert.equal(url.searchParams.get("space"), SPACE);
    assert.equal(url.searchParams.get("invite"), "a&invite=b");
  });
});

describe("shareUrl", () => {
  test("keeps the path of a same-document URL and swaps in the public origin", () => {
    // `page.url` as the Tauri webview rewrites it while hydrating.
    const url = shareUrl(PUBLIC_ORIGIN, `${Tauri}/${SPACE}?x=1#chat`);
    assert.equal(url.href, `${PUBLIC_ORIGIN}/${SPACE}?x=1#chat`);
  });

  test("resolves a relative URL without consulting the document", () => {
    // SvelteKit's `page.url` is relative on routes whose absolute URLs are
    // hydrated after parse; the path must survive, the origin must not leak in.
    assert.equal(shareUrl(PUBLIC_ORIGIN, "roomy.space").href, `${PUBLIC_ORIGIN}/roomy.space`);
  });
});
