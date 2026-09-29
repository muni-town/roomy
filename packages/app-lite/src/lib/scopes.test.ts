/**
 * Unit tests for the scope tier definitions and helpers in `scopes.ts`.
 *
 * `scopes.ts` is the single source of truth for every OAuth scope string the
 * app produces. These tests pin the semantics of the pure helpers:
 *
 *   - `parseScopes` — splitting/trimming, order-independence
 *   - `hasScopeSet` — membership vs partial sets, unknown scopes, order
 *   - `reconcileScope` — base always retained, unknown/out-of-ceiling scopes
 *     dropped, partial stored sets, dedupe
 *   - tier/ceiling invariants — every tier ⊂ ceiling (the PDS will reject any
 *     requested scope the metadata ceiling does not declare)
 *
 * Written against `node:test` + `node:assert` (app-lite's existing test
 * convention) so the file runs under `node --test --experimental-strip-types`.
 * It imports only `scopes.ts`, which has no `$env`/config dependencies.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SCOPE_SETS,
  FULL_SCOPE_CEILING,
  parseScopes,
  hasScopeSet,
  reconcileScope,
} from "./scopes.ts";

describe("parseScopes", () => {
  test("splits on single spaces, dropping empty tokens", () => {
    assert.deepEqual([...parseScopes("a b c")], ["a", "b", "c"]);
    assert.deepEqual([...parseScopes("")], []);
  });

  test("collapses repeated/leading/trailing spaces", () => {
    // Scope strings occasionally carry stray whitespace; a token set is
    // unaffected by how much whitespace separated the tokens.
    assert.deepEqual([...parseScopes("  a   b  ")], ["a", "b"]);
  });

  test("treats the string as an unordered set", () => {
    // Scope membership is the contract, not token order.
    const a = [...parseScopes("x y z")].sort();
    const b = [...parseScopes("z x y")].sort();
    assert.deepEqual(a, b);
  });

  test("preserves scopes with unusual characters", () => {
    // rpc: scopes embed `?aud=*`; repo scopes embed a `.`-delimited NSID.
    const parsed = parseScopes("atproto rpc:space.roomy.x.getY?aud=* blob:*/*");
    assert.equal(parsed.has("rpc:space.roomy.x.getY?aud=*"), true);
    assert.equal(parsed.has("blob:*/*"), true);
  });
});

describe("hasScopeSet", () => {
  test("true when every tier scope is present", () => {
    assert.equal(hasScopeSet(SCOPE_SETS.base, "base"), true);
  });

  test("false when only a partial set is granted", () => {
    const partial = SCOPE_SETS.base.split(" ").slice(0, 3).join(" ");
    assert.equal(hasScopeSet(partial, "base"), false);
  });

  test("is order-independent", () => {
    const reversed = SCOPE_SETS.base.split(" ").reverse().join(" ");
    assert.equal(hasScopeSet(reversed, "base"), true);
  });

  test("true with a superset (extra/unknown scopes do not hurt)", () => {
    const superset = `${SCOPE_SETS.base} rpc:some.unknown.method?aud=*`;
    assert.equal(hasScopeSet(superset, "base"), true);
  });

  test("false for the empty string", () => {
    assert.equal(hasScopeSet("", "base"), false);
  });
});

describe("reconcileScope", () => {
  const ceiling = FULL_SCOPE_CEILING;
  const base = SCOPE_SETS.base;
  const known = "rpc:space.roomy.space.getSpaces?aud=*";
  const unknown = "rpc:space.roomy.not.a.method?aud=*";

  test("returns base when stored is empty", () => {
    assert.equal(reconcileScope("", base, ceiling), base);
  });

  test("always retains the base tier", () => {
    // Even if the stored scope is completely empty, minimum functionality
    // (the base tier) must survive.
    const out = reconcileScope("", base, ceiling).split(" ");
    for (const s of base.split(" ")) assert.ok(out.includes(s));
  });

  test("retains stored scopes that are still within the ceiling", () => {
    assert.ok(reconcileScope(known, base, ceiling).includes(known));
  });

  test("drops stored scopes no longer in the ceiling", () => {
    // Requesting a scope the metadata no longer declares makes the PDS reject
    // with invalid_scope — reconcileScope must never emit it.
    const out = reconcileScope(`${base} ${unknown}`, base, ceiling);
    assert.equal(out.includes(unknown), false);
  });

  test("drops unknown scopes even when base is empty (custom ceiling)", () => {
    assert.equal(reconcileScope(unknown, "", "",).includes(unknown), false);
  });

  test("handles a partial stored scope against a custom base", () => {
    const smallBase = "atproto repo:space.roomy.user.profile";
    const smallCeiling = "atproto repo:space.roomy.user.profile rpc:a.b?aud=*";
    const out = reconcileScope("rpc:a.b?aud=*", smallBase, smallCeiling);
    const tokens = out.split(" ");
    assert.ok(tokens.includes("atproto"));
    assert.ok(tokens.includes("repo:space.roomy.user.profile"));
    assert.ok(tokens.includes("rpc:a.b?aud=*"));
  });

  test("dedupes without changing membership", () => {
    // A stored scope that already contains base tokens must not duplicate them.
    const doubled = `${base} ${base}`;
    const out = reconcileScope(doubled, base, ceiling);
    assert.deepEqual([...parseScopes(out)], [...parseScopes(base)]);
  });
});

describe("tier/ceiling invariants", () => {
  test("every base-tier scope is declared in the ceiling", () => {
    // The PDS enforces that a requested scope exists in the metadata ceiling;
    // the base tier is what we request at login, so base must be ⊆ ceiling.
    const ceilingSet = parseScopes(FULL_SCOPE_CEILING);
    for (const s of parseScopes(SCOPE_SETS.base)) {
      assert.ok(ceilingSet.has(s), `base scope missing from ceiling: ${s}`);
    }
  });

  test("ceiling contains every distinct base scope exactly once", () => {
    const ceilingTokens = FULL_SCOPE_CEILING.split(" ");
    assert.equal(new Set(ceilingTokens).size, ceilingTokens.length);
    const seen = new Set<string>();
    for (const s of SCOPE_SETS.base.split(" ")) {
      assert.ok(!seen.has(s), `duplicate base scope: ${s}`);
      seen.add(s);
    }
  });
});
