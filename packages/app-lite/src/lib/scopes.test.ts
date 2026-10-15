/**
 * Unit tests for the scope tier definitions and helpers in `scopes.ts`.
 *
 * `scopes.ts` is the single source of truth for every OAuth scope string the
 * app produces. These tests pin the semantics of the pure helpers:
 *
 *   - `parseScopes` — splitting/trimming, order-independence
 *   - `hasScopeSet` / `scopeCovers` — coverage under atproto's permission
 *     grammar: a grant in the expanded form a PDS returns still covers the
 *     request that asked for it, and one that genuinely lacks a permission
 *     still does not
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
  expandIncludedScopes,
  parseScopes,
  hasScopeSet,
  scopeCovers,
  scopeWithinCeiling,
  reconcileScope,
  isRequestableScopeSet,
  type ScopeSetName,
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

  test("the block feature's scopes are all deferred from the per-login request", () => {
    // The block write path needs two scopes — the `repo:` for the record and
    // the RPC the client fires afterwards (`refresh-blocks.ts`). Both are
    // registered on the HappyView API client at the same time, so both are
    // ceiling-only until then. A regression here is a sign-in outage: adding
    // the RPC to APPSERVER_RPCS put it in `base`, and HappyView rejected the
    // whole granted set at session registration for every user
    // ("scope 'rpc:space.roomy.user.refreshBlocks?aud=*' is not allowed").
    const deferred: Record<string, true> = {};
    for (const s of UNREGISTERED_SCOPES) deferred[s] = true;
    const baseSet = parseScopes(SCOPE_SETS.base);
    const blockScopes = [
      "repo:space.roomy.user.block",
      "rpc:space.roomy.user.refreshBlocks?aud=*",
    ];
    for (const s of blockScopes) {
      assert.equal(deferred[s], true, `block scope must be deferred: ${s}`);
      assert.equal(baseSet.has(s), false, `block scope leaked into base: ${s}`);
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

/**
 * A tier scope as the PDS returns it, which is not the string the client asked
 * for. Two rewrites are observed on live grants and modelled here:
 *
 *   - `include:` umbrellas arrive expanded into the permissions they name;
 *   - base asks for `getServiceAuth` both at the appserver DID and at `aud=*`,
 *     and the grant keeps only the `aud=*` form.
 *
 * Grants built from `SCOPE_SETS[tier]` itself — the request-side string, both
 * constructs intact — are round-trippable by construction and hid the defect
 * this suite exists to pin: coverage has to hold for the string a grant
 * actually is.
 */
function asGranted(requested: string): string {
  return expandIncludedScopes(requested)
    .split(" ")
    .filter(
      (s) => !/^rpc:com\.atproto\.server\.getServiceAuth\?aud=(?!\*)/.test(s),
    )
    .join(" ");
}

describe("scopeCovers", () => {
  test("a grant in the PDS's expanded form covers the base tier", () => {
    // The shape every live account's stored grant has: no `include:` token,
    // `getServiceAuth` at `aud=*` only. Membership said this covered nothing,
    // which is why no capability switch ever rendered on.
    const grant = asGranted(SCOPE_SETS.base);
    assert.equal(grant.includes("include:"), false);
    assert.equal(hasScopeSet(grant, "base"), true);
  });

  test("an rpc grant at aud=* implies the same lxm at a specific audience", () => {
    const wide = "rpc:com.atproto.server.getServiceAuth?aud=*";
    const narrow =
      "rpc:com.atproto.server.getServiceAuth?aud=did:web:api.roomy.space";
    assert.equal(scopeCovers(wide, narrow), true);
    // The converse is not coverage (`RpcPermission.matches` requires the grant
    // to name `*` or the exact audience), so a grant narrowed to one audience
    // must not read as a blanket one.
    assert.equal(scopeCovers(narrow, wide), false);
    assert.equal(
      scopeCovers(narrow.replace("api.roomy.space", "other.example"), narrow),
      false,
    );
  });

  test("an include: request is covered by the permissions it expands to", () => {
    const expansion = "rpc:space.roomy.authComplete.arbiter.proxy?aud=*";
    assert.equal(
      scopeCovers(expansion, "include:space.roomy.authComplete"),
      true,
    );
    // A grant without the expansion does not cover the umbrella, and an
    // include: with no known expansion satisfies nothing but itself.
    assert.equal(
      scopeCovers("atproto", "include:space.roomy.authComplete"),
      false,
    );
    assert.equal(scopeCovers("atproto", "include:space.roomy.mystery"), false);
  });

  test("repo: grants every action unless it names one", () => {
    assert.equal(
      scopeCovers(
        "repo:network.cosmik.card",
        "repo:network.cosmik.card?action=create",
      ),
      true,
    );
    assert.equal(
      scopeCovers(
        "repo:network.cosmik.card?action=create,update",
        "repo:network.cosmik.card?action=update",
      ),
      true,
    );
    // Part of the actions is not the whole collection, and another
    // collection's grant does not reach this one.
    assert.equal(
      scopeCovers(
        "repo:network.cosmik.card?action=create",
        "repo:network.cosmik.card",
      ),
      false,
    );
    assert.equal(
      scopeCovers(
        "repo:network.cosmik.card?action=create",
        "repo:network.cosmik.card?action=create,delete",
      ),
      false,
    );
    assert.equal(
      scopeCovers(
        "repo:space.roomy.user.profile",
        "repo:network.cosmik.card?action=create",
      ),
      false,
    );
  });

  test("the universal blob accept covers any MIME type", () => {
    assert.equal(scopeCovers("blob:*/*", "blob:image/png"), true);
    assert.equal(scopeCovers("blob:image/*", "blob:image/png"), true);
    assert.equal(scopeCovers("blob:image/png", "blob:image/jpeg"), false);
  });

  test("nothing covers an empty grant", () => {
    assert.equal(scopeCovers("", "atproto"), false);
  });
});

describe("capability coverage of a stored grant", () => {
  test("an expanded grant lights the capability it carries and no other", () => {
    // The two switches must disagree: only reading the real grant can put the
    // Semble row on while the DM row stays off.
    const grant = asGranted(SCOPE_SETS.semble);
    assert.equal(hasScopeSet(grant, "semble"), true);
    assert.equal(hasScopeSet(grant, "withDms"), false);
    assert.deepEqual(coveredCapabilities(grant), ["semble"]);
  });

  test("a grant that genuinely lacks a capability still reads false", () => {
    // base is covered, so this is not a predicate that fails everything: the
    // cosmik extra is what is absent, and only that.
    const grant = asGranted(SCOPE_SETS.base);
    assert.equal(hasScopeSet(grant, "base"), true);
    assert.equal(hasScopeSet(grant, "semble"), false);
    assert.deepEqual(coveredCapabilities(grant), []);
  });

  test("a union grant covers every capability it names", () => {
    const grant = asGranted(capabilityScope(["semble", "withDms"]));
    assert.deepEqual(coveredCapabilities(grant), ["semble", "withDms"]);
  });
});

describe("isRequestableScopeSet", () => {
  test("is true for a registered tier and false for a ceiling-only one", () => {
    // The split the reactive flow reads before choosing a dialogue. A wrong
    // `true` drives a consent round-trip for a scope the deployed client
    // refuses, and the client rejects the whole granted set at session
    // registration — a failed sign-in for every user, not a failed feature.
    for (const tier of Object.keys(REQUESTABLE_SCOPE_SETS)) {
      assert.equal(isRequestableScopeSet(tier as ScopeSetName), true, tier);
    }
    for (const tier of Object.keys(SCOPE_SETS)) {
      if (tier in REQUESTABLE_SCOPE_SETS) continue;
      assert.equal(isRequestableScopeSet(tier as ScopeSetName), false, tier);
    }
    // The tiers the notice exists for, named so a rename cannot quietly make
    // this vacuous.
    assert.equal(isRequestableScopeSet("blocks"), false);
    assert.equal(isRequestableScopeSet("voice"), false);
    assert.equal(isRequestableScopeSet("semble"), true);
  });
});
