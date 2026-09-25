/**
 * The deployed bundle must name its commit, and the build must refuse to
 * publish one that cannot.
 *
 * `__BUILD_ID__` is baked into the bundle and served as `/build.json` from that
 * same value: both surfaces read the one define resolved in `vite.config.ts`,
 * so they cannot disagree about which commit they are. Without it the only
 * stamp on a deployed client is SvelteKit's `/_app/version.json`, a build
 * *timestamp* with no commit mapping, which identifies nothing about the code
 * being served.
 *
 * These assertions read the tree, not a build: a full 9.4k-module Vite build is
 * minutes of CI and OOM-prone on small hosts, and the failures worth catching
 * here are structural (no route, no consumer, identity not supplied by the
 * script) rather than runtime. A served `/build.json` carrying the commit the
 * image was built from is the end-to-end behaviour these checks stand in for.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency; app-lite ships no test runner of its own) so the file runs under
 * both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("app-lite build identity is observable", () => {
  test("a prerendered /build.json route exists", () => {
    const route = read("../routes/build.json/+server.ts");
    assert.match(route, /export\s+const\s+prerender\s*=\s*true/);
    assert.match(route, /__BUILD_ID__/);
    assert.match(route, /commit/);
  });

  test("the route reports the same id the bundle was built with", () => {
    // Both surfaces read the one define resolved in vite.config.ts, so they
    // cannot disagree about which commit they are.
    const config = read("../../vite.config.ts");
    assert.match(config, /__BUILD_ID__/);
    assert.match(config, /resolveBuildId/);
    assert.match(config, /JSON\.stringify\(BUILD_ID\)/);
  });

  test("vite.config.ts does not emit the literal undefined", () => {
    // `process.env.BUILD_ID ? JSON.stringify(...) : "undefined"` would bake an
    // absent id into the bundle as the four-character string "undefined".
    const config = read("../../vite.config.ts");
    assert.doesNotMatch(config, /:\s*"undefined"/);
  });

  test("the production build script supplies a BUILD_ID", () => {
    const script = read("../../scripts/build-prod.sh");
    assert.match(script, /BUILD_ID/);
    assert.match(script, /RAILWAY_GIT_COMMIT_SHA/);
  });

  test("the build fails rather than publish an unnameable bundle", () => {
    const script = read("../../scripts/build-prod.sh");
    assert.match(script, /build-staging\/build\.json/);
    // The empty-commit case: present but meaningless downstream.
    assert.match(script, /built_commit/);
  });
});
