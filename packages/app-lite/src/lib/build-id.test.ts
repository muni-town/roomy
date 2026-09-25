/**
 * The build-identity rule: a bundle must be able to name its commit, and a
 * build with no git metadata must say `unknown` rather than something
 * present-but-empty (which no consumer downstream can tell from a real id).
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveBuildId } from "./build-id.ts";

const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("resolveBuildId", () => {
  test("BUILD_ID wins over the platform sha", () => {
    assert.equal(
      resolveBuildId({ BUILD_ID: "abc12345", RAILWAY_GIT_COMMIT_SHA: SHA }),
      "abc12345",
    );
  });

  test("RAILWAY_GIT_COMMIT_SHA is the fallback when BUILD_ID is absent", () => {
    assert.equal(resolveBuildId({ RAILWAY_GIT_COMMIT_SHA: SHA }), SHA);
  });

  test("a deploy with no git metadata reports unknown, never a blank", () => {
    const id = resolveBuildId({});
    assert.equal(id, "unknown");
    assert.notEqual(id, "");
  });

  // The exact shape Dockerfile.app-lite produces when built without
  // --build-arg RAILWAY_GIT_COMMIT_SHA: `ENV BUILD_ID=${SHA%...}` is "".
  // A raw `??` chain keeps that "", which is indistinguishable from a real
  // identity to every consumer downstream.
  test("an empty BUILD_ID falls through to the platform sha", () => {
    assert.equal(resolveBuildId({ BUILD_ID: "", RAILWAY_GIT_COMMIT_SHA: SHA }), SHA);
  });

  test("a whitespace-only BUILD_ID is absent, not an identity", () => {
    assert.equal(resolveBuildId({ BUILD_ID: "   ", RAILWAY_GIT_COMMIT_SHA: SHA }), SHA);
  });

  test("all-empty variables report unknown, never a blank", () => {
    const id = resolveBuildId({
      BUILD_ID: "",
      RAILWAY_GIT_COMMIT_SHA: "",
    });
    assert.equal(id, "unknown");
    assert.notEqual(id, "");
  });
});
