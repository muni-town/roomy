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
  CAPABILITY_SCOPES,
  SCOPE_SETS,
  REQUESTABLE_SCOPE_SETS,
  FULL_SCOPE_CEILING,
  UNREGISTERED_SCOPES,
  CLIENT_ID_SCOPE,
  capabilityScope,
  coveredCapabilities,
  parseScopes,
  hasScopeSet,
  scopeWithinCeiling,
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

describe("scopeWithinCeiling", () => {
  test("true when every token is declared in the ceiling", () => {
    assert.equal(scopeWithinCeiling(SCOPE_SETS.base, FULL_SCOPE_CEILING), true);
  });

  test("false when any token is absent from the ceiling", () => {
    assert.equal(
      scopeWithinCeiling(`${SCOPE_SETS.base} rpc:x.y?aud=*`, FULL_SCOPE_CEILING),
      false,
    );
  });

  test("the DM tier is outside the dev loopback ceiling but inside the full one", () => {
    // The loopback client id is narrower than the metadata ceiling (Referer
    // cap), so `withDms` is requestable only where the full ceiling is declared
    // — the deployed web / desktop clients. This is the guard
    // `requestScopeExpansion` applies before a consent round-trip.
    assert.equal(scopeWithinCeiling(SCOPE_SETS.withDms, CLIENT_ID_SCOPE), false);
    assert.equal(scopeWithinCeiling(SCOPE_SETS.withDms, FULL_SCOPE_CEILING), true);
    assert.equal(scopeWithinCeiling(SCOPE_SETS.semble, CLIENT_ID_SCOPE), true);
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

describe("capabilityScope", () => {
  test("is the deduped union of base and every enabled capability's extras", () => {
    // The whole point of the union model: an enabled capability ADDS its
    // extras, it does not replace another's. `{semble, withDms}` must therefore
    // contain all three sets, each token once.
    const union = capabilityScope(["semble", "withDms"]);
    const tokens = parseScopes(union);
    for (const s of [
      ...parseScopes(SCOPE_SETS.base),
      ...CAPABILITY_SCOPES.semble,
      ...CAPABILITY_SCOPES.withDms,
    ]) {
      assert.ok(tokens.has(s), `union missing ${s}`);
    }
    assert.equal(union.split(" ").length, tokens.size);
  });

  test("enabling a second capability does not drop the first", () => {
    // This is the behaviour the settings page's independent switches promise:
    // {semble} ⊆ {semble, withDms}, so requesting the wider union still covers
    // everything the narrower one did.
    const semble = parseScopes(capabilityScope(["semble"]));
    const both = parseScopes(capabilityScope(["semble", "withDms"]));
    for (const s of semble) assert.ok(both.has(s), `union dropped ${s}`);
    assert.ok(both.size > semble.size, "expected the union to be strictly wider");
  });

  test("with no capability enabled it is exactly base", () => {
    assert.deepEqual(
      [...parseScopes(capabilityScope([]))],
      [...parseScopes(SCOPE_SETS.base)],
    );
  });

  test("keeps base order first, then the capabilities' extras", () => {
    const tokens = capabilityScope(["withDms", "semble"]).split(" ");
    assert.deepEqual(tokens.slice(0, parseScopes(SCOPE_SETS.base).size), [
      ...parseScopes(SCOPE_SETS.base),
    ]);
  });

  test("drops a capability's extras that the ceiling does not declare", () => {
    // The loopback client id deliberately declares base + semble only. Asking
    // for DMs there must not emit a token the client cannot request — the PDS
    // rejects the whole authorization with invalid_scope.
    const loopback = capabilityScope(["semble", "withDms"], SCOPE_SETS.base, CLIENT_ID_SCOPE);
    const tokens = parseScopes(loopback);
    for (const s of CAPABILITY_SCOPES.semble) assert.ok(tokens.has(s));
    for (const s of CAPABILITY_SCOPES.withDms) assert.equal(tokens.has(s), false);
    assert.equal(scopeWithinCeiling(loopback, CLIENT_ID_SCOPE), true);
  });

  test("every token of a full-ceiling union is declared in the ceiling", () => {
    const union = capabilityScope(["semble", "withDms"], SCOPE_SETS.base, FULL_SCOPE_CEILING);
    assert.equal(scopeWithinCeiling(union, FULL_SCOPE_CEILING), true);
  });
});

describe("coveredCapabilities", () => {
  test("names every capability whose extras the scope carries", () => {
    assert.deepEqual(coveredCapabilities(capabilityScope(["semble", "withDms"])), [
      "semble",
      "withDms",
    ]);
  });

  test("is the inverse of capabilityScope for a base-only grant", () => {
    assert.deepEqual(coveredCapabilities(SCOPE_SETS.base), []);
    assert.deepEqual(coveredCapabilities(capabilityScope(["semble"])), ["semble"]);
  });

  test("null and empty grants cover nothing", () => {
    assert.deepEqual(coveredCapabilities(null), []);
    assert.deepEqual(coveredCapabilities(""), []);
  });

  test("a partial capability's extras do not count as covered", () => {
    // Half of a capability's tokens is not the capability: narrowing must not
    // treat a hand-narrowed grant as still having it on.
    const partial = capabilityScope(["semble"])
      .split(" ")
      .filter((s) => s !== CAPABILITY_SCOPES.semble[0])
      .join(" ");
    assert.deepEqual(coveredCapabilities(partial), []);
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

  test("base tier requests no chat.bsky scopes (Chat access is opt-in)", () => {
    // The `withDms` tier holds the Bluesky DM rpc scopes. First login must
    // request only `base`, so no chat scope may leak into it — otherwise the
    // consent screen asks for Chat access up front. The chat scopes must
    // still exist in the ceiling so a later opt-in can request them.
    const chatScopes = [...parseScopes(SCOPE_SETS.withDms)].filter((s) =>
      s.includes("chat.bsky."),
    );
    assert.ok(chatScopes.length > 0, "withDms should carry chat.bsky scopes");
    const baseSet = parseScopes(SCOPE_SETS.base);
    for (const s of chatScopes) {
      assert.equal(baseSet.has(s), false, `chat scope leaked into base: ${s}`);
    }
  });

  test("no requestable tier asks for a scope the HappyView client does not allow", () => {
    // This is the invariant that a sign-in outage is made of. A requestable
    // tier's scope goes out as the authorization request; after the user
    // consents, the client hands the granted set to HappyView at
    // POST /oauth/sessions. HappyView validates it against the API client's
    // registered scope allowlist and rejects the WHOLE set if any one token is
    // missing — after consent, before any session exists:
    //
    //   400 {"error":"scope '<token>' is not allowed for this client"}
    //
    // The user sees OAuthCallbackError: Failed to register session, and since
    // registration is what makes an account usable, a token in `base` that the
    // deployed client does not list breaks sign-in for every user at once.
    // UNREGISTERED_SCOPES is the repo's record of that out-of-band list.
    const unregistered: Record<string, true> = {};
    for (const s of UNREGISTERED_SCOPES) unregistered[s] = true;
    for (const [tier, scope] of Object.entries(REQUESTABLE_SCOPE_SETS)) {
      for (const s of parseScopes(scope)) {
        assert.ok(
          !unregistered[s],
          `tier ${tier} requests a scope the HappyView client does not allow: ${s}`,
        );
      }
    }
  });

  test("ceiling-only scopes stay declared but unrequestable", () => {
    // A deferred scope must still be in the ceiling (so registering it on the
    // client later needs no metadata rebuild) while appearing in no requestable
    // tier. Asserted as set membership rather than by naming the tokens, so
    // this holds for whatever the next deferred feature is.
    assert.ok(UNREGISTERED_SCOPES.length > 0, "expected a deferred scope to exist");
    const ceilingSet = parseScopes(FULL_SCOPE_CEILING);
    const requestable: Record<string, true> = {};
    for (const scope of Object.values(REQUESTABLE_SCOPE_SETS)) {
      for (const s of parseScopes(scope)) requestable[s] = true;
    }
    for (const s of UNREGISTERED_SCOPES) {
      assert.ok(ceilingSet.has(s), `deferred scope missing from ceiling: ${s}`);
      assert.ok(
        !requestable[s],
        `deferred scope leaked into a requestable tier: ${s}`,
      );
    }
  });

  test("CLIENT_ID_SCOPE covers the requestable tiers a loopback login can request", () => {
    // The dev loopback client id embeds this scope; the PDS records the client
    // id with the authorization request and rejects a differing one at token
    // exchange/refresh ("Token was not issued to this client"). So it must be
    // (a) constant — the same for every login/init/restore — and (b) a superset
    // of every per-login scope the loopback client can request, or the PDS
    // would reject a requested scope the client id's metadata does not declare.
    //
    // `withDms` is deliberately NOT covered: its client id overflows the
    // browser Referer cap (see the length test below), so no loopback login can
    // request it. It stays requestable for the deployed HappyView client, whose
    // client id is a short metadata URL.
    const clientIdSet = parseScopes(CLIENT_ID_SCOPE);
    for (const tier of ["base", "semble"] as const) {
      for (const s of parseScopes(REQUESTABLE_SCOPE_SETS[tier])) {
        assert.ok(
          clientIdSet.has(s),
          `requestable tier ${tier} scope not covered by CLIENT_ID_SCOPE: ${s}`,
        );
      }
    }
  });

  test("CLIENT_ID_SCOPE's loopback client_id stays under the browser Referer cap", () => {
    // The client id is a query param of the authorize request, whose URL
    // becomes the consent page's Referer. Browsers cap the Referer at 4096
    // bytes and strip it to the origin past that, after which the PDS rejects
    // the consent submission with "Invalid referrer". The SDK throws below the
    // cap (packages/sdk/src/browser/oauth.ts, assertLoopbackClientIdLength), so
    // this pins that the scope we ship does not trip it.
    const redirectUri = "http://127.0.0.1:5180/";
    const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(CLIENT_ID_SCOPE)}`;
    // Mirrors the SDK guard: the encoded client id plus the authorize URL's
    // endpoint/`request_uri`/separators must fit under 4096.
    const urlLength = encodeURIComponent(clientId).length + 384;
    assert.ok(
      urlLength <= 4096,
      `loopback authorize URL too long for the Referer cap: ${urlLength}`,
    );
  });
});
