/**
 * Unit tests for `scope-grant.ts` — the pure grant-tracking decisions that
 * `auth.svelte.ts` applies (kept out of the `svelte.ts` module so they run
 * under app-lite's `node --test --experimental-strip-types` runner).
 *
 * Pins two contracts:
 *
 *   - `decideLoginScope` — how a stored scope from `getLoginScope` becomes the
 *     exact scope requested at login. null/empty → base; stored → reconciled.
 *   - `APP_PASSWORD_GRANTED_SCOPE` — the app-password (test-mode) path has no
 *     OAuth token, so its granted scope is the requested tier, and no
 *     `recordScopeGrant` is ever sent.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SCOPE_SETS } from "./scopes.ts";
import {
  APP_PASSWORD_GRANTED_SCOPE,
  decideLoginScope,
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
});

describe("APP_PASSWORD_GRANTED_SCOPE", () => {
  test("is the base tier (app-password sessions carry no OAuth token)", () => {
    assert.equal(APP_PASSWORD_GRANTED_SCOPE, SCOPE_SETS.base);
  });
});
