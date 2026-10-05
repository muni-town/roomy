/**
 * Tests for the origins that make an absolute link an internal space/room
 * reference.
 *
 * A space reference is only meaningful on the appserver that materialises it,
 * so the set of origins that count as internal depends on which appserver the
 * client talks to: production's world is served at `roomy.space`, staging's at
 * `next.roomy.space`, and a self-hosted deployment serves its own.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the file
 * runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { internalOriginsFor } from "./internal-link-origins.ts";

describe("internalOriginsFor", () => {
  test("a production deployment served at its appserver's web origin", () => {
    assert.deepEqual(
      internalOriginsFor("did:web:api.roomy.space", "https://roomy.space"),
      ["https://roomy.space"],
    );
  });

  test("a staging deployment served at its appserver's web origin", () => {
    assert.deepEqual(
      internalOriginsFor(
        "did:web:api-staging.roomy.space",
        "https://next.roomy.space",
      ),
      ["https://next.roomy.space"],
    );
  });

  test("a deployment served somewhere else also accepts its appserver's origin", () => {
    // A Netlify deploy preview is served from its own domain but still talks
    // to the staging appserver, so a link to next.roomy.space names a space
    // that appserver holds — it must be internal there too.
    assert.deepEqual(
      internalOriginsFor(
        "did:web:api-staging.roomy.space",
        "https://deploy-preview-42--roomy.netlify.app",
      ),
      [
        "https://deploy-preview-42--roomy.netlify.app",
        "https://next.roomy.space",
      ],
    );
  });

  test("a staging deployment does not accept production's origin", () => {
    // The staging appserver does not hold production's spaces, so a link to
    // roomy.space is a reference to a world this client cannot resolve.
    const origins = internalOriginsFor(
      "did:web:api-staging.roomy.space",
      "https://next.roomy.space",
    );
    assert.equal(origins.includes("https://roomy.space"), false);
  });

  test("a self-hosted appserver offers only the document's own origin", () => {
    assert.deepEqual(
      internalOriginsFor("did:web:chat.example.com", "https://chat.example.com"),
      ["https://chat.example.com"],
    );
    assert.deepEqual(
      internalOriginsFor("did:web:localhost%3A8080", "http://127.0.0.1:5180"),
      ["http://127.0.0.1:5180"],
    );
  });

  test("with no document origin only the appserver's web origin applies", () => {
    // Server-side rendering has no document; the appserver's world is still
    // known, so its origin alone remains internal.
    assert.deepEqual(
      internalOriginsFor("did:web:api.roomy.space", ""),
      ["https://roomy.space"],
    );
    assert.deepEqual(internalOriginsFor("did:web:chat.example.com", ""), []);
  });

  test("the document origin is never repeated", () => {
    assert.deepEqual(
      internalOriginsFor("did:web:api.roomy.space", "https://roomy.space"),
      ["https://roomy.space"],
    );
  });
});
