/**
 * Unit tests for `scope-grant.ts` — the pure grant-tracking decisions that
 * `auth.svelte.ts` applies (kept out of the `svelte.ts` module so they run
 * under app-lite's `node --test --experimental-strip-types` runner).
 *
 * Pins three contracts:
 *
 *   - `decideLoginScope` — how a stored scope from `getLoginScope` becomes the
 *     exact scope requested at login. null/empty → base; stored → reconciled.
 *   - `decideScopeReauthIdentity` — the identity a scope expansion
 *     re-authorizes as must be the session DID, not the in-memory handle,
 *     because the PDS redirect drops the latter (the callback runs in a fresh
 *     document).
 *   - `APP_PASSWORD_GRANTED_SCOPE` — the app-password (test-mode) path has no
 *     OAuth token, so its granted scope is the requested tier, and no
 *     `recordScopeGrant` is ever sent.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_ID_SCOPE, FULL_SCOPE_CEILING, SCOPE_SETS } from "./scopes.ts";
import {
  APP_PASSWORD_GRANTED_SCOPE,
  decideLoginScope,
  decideScopeReauthIdentity,
} from "./scope-grant.ts";

describe("decideLoginScope", () => {
  test("returns the base tier when the server has no stored scope", () => {
    assert.equal(decideLoginScope(null), SCOPE_SETS.base);
    assert.equal(decideLoginScope(undefined), SCOPE_SETS.base);
  });

  test("returns base for empty / whitespace-only stored scope", () => {
    assert.equal(decideLoginScope(""), SCOPE_SETS.base);
    assert.equal(decideLoginScope("   "), SCOPE_SETS.base);
  });

  test("reconciles a stored scope that is a subset of base", () => {
    // A stored grant missing some base tokens must still come back covering
    // the full base tier (reconcileScope always retains base).
    const partial = SCOPE_SETS.base.split(" ").slice(0, 2).join(" ");
    const out = decideLoginScope(partial);
    for (const s of SCOPE_SETS.base.split(" ")) {
      assert.ok(out.split(" ").includes(s), `missing base scope: ${s}`);
    }
  });

  test("re-login with a stale stored base requests the CURRENT (grown) base", () => {
    // Trap (b): a user whose stored grant predates the base tier's growth.
    // decideLoginScope must return today's full base (which the PDS shows as
    // a consent delta against the old grant), never the stale smaller set.
    // The stored grant here simulates an old base lacking the authComplete
    // umbrella token the arbiter-proxy feature needs — the same growth that
    // left an admin holding a base that no longer covers their create-card
    // action.
    const staleStored = SCOPE_SETS.base
      .split(" ")
      .filter((s) => s !== "include:space.roomy.authComplete")
      .join(" ");
    const out = decideLoginScope(staleStored);
    assert.equal(out, SCOPE_SETS.base); // full, current base — not the stale one
    assert.ok(out.split(" ").includes("include:space.roomy.authComplete"));
  });

  test("reconciles a stored scope that includes base extras", () => {
    // base retains the minimum; anything stored still within the ceiling is
    // kept, so a returning user keeps their previously-granted accesses.
    const ext = "rpc:space.roomy.auth.getLoginScope?aud=*";
    const out = decideLoginScope(`${SCOPE_SETS.base} ${ext}`);
    assert.ok(out.split(" ").includes(ext));
  });

  test("drops a stored scope token that is no longer in the ceiling", () => {
    // Requesting a scope the metadata no longer declares → PDS
    // invalid_scope; decideLoginScope must never emit it.
    const stale = "rpc:space.roomy.not.a.real.method?aud=*";
    const out = decideLoginScope(`${SCOPE_SETS.base} ${stale}`);
    assert.ok(!out.split(" ").includes(stale));
  });

  test("drops a stored scope token absent from the ACTIVE client's ceiling", () => {
    // The regression: on the dev loopback client the active ceiling is the
    // narrower CLIENT_ID_SCOPE, not the full metadata ceiling. A stored grant
    // can contain tokens the PDS expanded an `include:` into (e.g. the
    // arbiter-proxy RPC) — present in FULL_SCOPE_CEILING but absent from the
    // loopback client id. Reconciling against the full ceiling re-requests
    // them, and the PDS rejects the whole authorization with `invalid_scope`.
    // Passed the active ceiling, they are dropped before the request.
    const storedWithIncludeExpansion = `${SCOPE_SETS.base} rpc:space.roomy.authComplete.arbiter.proxy?aud=*`;
    assert.ok(
      FULL_SCOPE_CEILING.split(" ").includes(
        "rpc:space.roomy.authComplete.arbiter.proxy?aud=*",
      ),
      "precondition: token is in the full ceiling",
    );

    const out = decideLoginScope(storedWithIncludeExpansion, CLIENT_ID_SCOPE);
    assert.ok(
      !out.split(" ").includes(
        "rpc:space.roomy.authComplete.arbiter.proxy?aud=*",
      ),
      "token outside the active loopback ceiling must not be requested",
    );
    // The full ceiling still keeps it (deployed/Tauri clients declare it).
    assert.ok(
      decideLoginScope(storedWithIncludeExpansion, FULL_SCOPE_CEILING)
        .split(" ")
        .includes("rpc:space.roomy.authComplete.arbiter.proxy?aud=*"),
    );
  });

  test("every token the reconcile result can emit is in the active ceiling", () => {
    // Property: reconcileScope(stored, base, ceiling) ⊆ base ∪ ceiling. With the
    // loopback ceiling, that is exactly base ∪ CLIENT_ID_SCOPE — the set the
    // loopback client declares — so no result token can trip invalid_scope.
    const stored = `${FULL_SCOPE_CEILING}`;
    const out = decideLoginScope(stored, CLIENT_ID_SCOPE);
    const allowed = new Set(`${SCOPE_SETS.base} ${CLIENT_ID_SCOPE}`.split(" ").filter(Boolean));
    for (const s of out.split(" ")) {
      assert.ok(allowed.has(s), `reconciled token not in active ceiling: ${s}`);
    }
  });
});

describe("decideScopeReauthIdentity", () => {
  // The bug: an expansion runs after a PDS redirect, so the handle typed at
  // login (an in-memory value) is gone. The session DID survives and must be
  // what drives the round-trip — otherwise `requestScopeExpansion` no-ops and
  // the guarded action rethrows the original scope-miss.
  test("prefers the session DID whenever one exists", () => {
    assert.equal(
      decideScopeReauthIdentity({
        sessionDid: "did:plc:alice",
        handle: "alice.test",
      }),
      "did:plc:alice",
    );
  });

  test("falls back to the handle only when there is no session DID", () => {
    assert.equal(
      decideScopeReauthIdentity({ handle: "alice.test" }),
      "alice.test",
    );
  });

  test("returns null for a sessionless caller", () => {
    // The settings page can be reached signed out: no identity to re-authorize
    // with, so the caller records intent instead of driving a doomed redirect.
    assert.equal(decideScopeReauthIdentity({}), null);
    assert.equal(decideScopeReauthIdentity({ sessionDid: "", handle: "" }), null);
  });
});

describe("APP_PASSWORD_GRANTED_SCOPE", () => {
  test("is the base tier (app-password sessions carry no OAuth token)", () => {
    assert.equal(APP_PASSWORD_GRANTED_SCOPE, SCOPE_SETS.base);
  });
});
