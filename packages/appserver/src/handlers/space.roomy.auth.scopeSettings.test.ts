/**
 * Unit tests for the Phase-4 scope-settings handlers:
 *   - `space.roomy.auth.getScopeSettings`   (query, AUTHENTICATED)
 *   - `space.roomy.auth.setScopeSettings`   (procedure, AUTHENTICATED)
 *   - `isStrictScopeExpansion` (pure helper)
 *
 * Both handlers read/write `user_oauth_grants` and `user_scope_intents` in
 * the read-state DB, so these run with in-memory DBs. No handle resolution
 * here (unlike the getLoginScope tests) — both handlers are authenticated and
 * take the DID from auth, so no network is touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openReadStateDb } from "../db/db.ts";
import { recordScopeGrantHandler } from "./space.roomy.auth.recordScopeGrant.ts";
import { getScopeSettingsHandler } from "./space.roomy.auth.getScopeSettings.ts";
import { setScopeSettingsHandler } from "./space.roomy.auth.setScopeSettings.ts";
import { isStrictScopeExpansion } from "../xrpc/scopeExpansion.ts";

const USER = UserDid.assert("did:plc:scope-settings-user");
const OTHER = UserDid.assert("did:plc:scope-settings-other");

const BASE_SCOPE = "atproto rpc:space.roomy.space.getSpaces blob:*/*";
/** A strict superset of BASE_SCOPE — the Semble extension as a raw string. */
const SEMBLE_SCOPE = `${BASE_SCOPE} repo:network.cosmik.card?action=create`;
/** Partial set, not a superset of BASE_SCOPE. */
const NARROWED_SCOPE = "atproto rpc:space.roomy.space.getSpaces";

async function storedScope(did: string): Promise<string | null> {
  const row = await openReadStateDb()
    .query("select granted_scope from user_oauth_grants where user_did = ?")
    .get<{ granted_scope: string }>(did);
  return row?.granted_scope ?? null;
}

async function requestedScope(did: string): Promise<string | null> {
  const row = await openReadStateDb()
    .query("select requested_scope from user_scope_intents where user_did = ?")
    .get<{ requested_scope: string }>(did);
  return row?.requested_scope ?? null;
}

beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
});

afterEach(() => {
  closeDb();
});

describe("isStrictScopeExpansion", () => {
  test("true for a strict superset", () => {
    expect(isStrictScopeExpansion(SEMBLE_SCOPE, BASE_SCOPE)).toBe(true);
  });

  test("true for a grown base over an older, smaller base (trap b)", () => {
    // A user whose STORED grant predates the base's growth holds an old,
    // smaller base. Re-requesting today's (larger) BASE_SCOPE is a real
    // expansion — the PDS must show the consent delta, not treat it as a
    // no-op. This is the production case: an admin with an old base hits a
    // feature that needs the newly-added base token.
    const OLD_BASE = "atproto rpc:space.roomy.space.getSpaces";
    expect(isStrictScopeExpansion(BASE_SCOPE, OLD_BASE)).toBe(true);
  });

  test("false for a proper subset (revoke)", () => {
    expect(isStrictScopeExpansion(NARROWED_SCOPE, BASE_SCOPE)).toBe(false);
  });

  test("false for equal sets", () => {
    expect(isStrictScopeExpansion(BASE_SCOPE, BASE_SCOPE)).toBe(false);
  });

  test("false when desired is empty", () => {
    expect(isStrictScopeExpansion("", BASE_SCOPE)).toBe(false);
    expect(isStrictScopeExpansion("   ", null)).toBe(false);
  });

  test("true when granted is null and desired is non-empty", () => {
    expect(isStrictScopeExpansion(BASE_SCOPE, null)).toBe(true);
  });

  test("false for disjoint sets", () => {
    const other = "rpc:foo?aud=* blob:*/*";
    expect(isStrictScopeExpansion(other, BASE_SCOPE)).toBe(false);
  });
});

describe("space.roomy.auth.getScopeSettings", () => {
  test("401 when unauthenticated", async () => {
    await expect(
      getScopeSettingsHandler({}, { did: null }),
    ).rejects.toMatchObject({ status: 401, xrpcError: "AuthRequired" });
  });

  test("returns null scope/request for a user with no rows", async () => {
    const res = await getScopeSettingsHandler({}, { did: USER });
    expect(res.scope).toBeNull();
    expect(res.requestedScope).toBeNull();
  });

  test("returns the stored grant scope", async () => {
    await recordScopeGrantHandler({}, { did: USER }, { scope: BASE_SCOPE });
    const res = await getScopeSettingsHandler({}, { did: USER });
    expect(res.scope).toBe(BASE_SCOPE);
    expect(res.requestedScope).toBeNull();
  });

  test("returns a pending requested scope alongside it", async () => {
    await setScopeSettingsHandler({}, { did: USER }, { scope: SEMBLE_SCOPE });
    const res = await getScopeSettingsHandler({}, { did: USER });
    expect(res.scope).toBeNull();
    expect(res.requestedScope).toBe(SEMBLE_SCOPE);
  });

  test("is per-user", async () => {
    await setScopeSettingsHandler({}, { did: USER }, { scope: SEMBLE_SCOPE });
    const otherRes = await getScopeSettingsHandler({}, { did: OTHER });
    expect(otherRes.scope).toBeNull();
    expect(otherRes.requestedScope).toBeNull();
  });
});

describe("space.roomy.auth.setScopeSettings", () => {
  test("401 when unauthenticated", async () => {
    await expect(
      setScopeSettingsHandler({}, { did: null }, { scope: BASE_SCOPE }),
    ).rejects.toMatchObject({ status: 401, xrpcError: "AuthRequired" });
  });

  test("400 on missing/empty scope", async () => {
    await expect(
      setScopeSettingsHandler({}, { did: USER }, {}),
    ).rejects.toMatchObject({ status: 400, xrpcError: "InvalidRequest" });
    await expect(
      setScopeSettingsHandler({}, { did: USER }, { scope: "" }),
    ).rejects.toMatchObject({ status: 400, xrpcError: "InvalidRequest" });
    await expect(
      setScopeSettingsHandler({}, { did: USER }, { scope: "   " }),
    ).rejects.toMatchObject({ status: 400, xrpcError: "InvalidRequest" });
  });

  test("expanding does NOT write the grant (needs consent round-trip)", async () => {
    await setScopeSettingsHandler({}, { did: USER }, { scope: BASE_SCOPE });
    // Only the intent is recorded; the grant is untouched.
    expect(await storedScope(USER)).toBeNull();
    expect(await requestedScope(USER)).toBe(BASE_SCOPE);
  });

  test("records the intent as the raw desired scope", async () => {
    await setScopeSettingsHandler({}, { did: USER }, { scope: SEMBLE_SCOPE });
    expect(await requestedScope(USER)).toBe(SEMBLE_SCOPE);
  });

  test("narrowing clears an existing pending expansion", async () => {
    await setScopeSettingsHandler({}, { did: USER }, { scope: SEMBLE_SCOPE });
    expect(await requestedScope(USER)).toBe(SEMBLE_SCOPE);

    // A non-expansion request (equal to the stored scope, or a subset after a
    // grant exists) clears the pending intent.
    await setScopeSettingsHandler({}, { did: USER }, { scope: NARROWED_SCOPE });
    expect(await requestedScope(USER)).toBeNull();
  });

  test("narrowing clears the intent once a grant exists", async () => {
    await recordScopeGrantHandler({}, { did: USER }, { scope: BASE_SCOPE });
    await setScopeSettingsHandler({}, { did: USER }, { scope: BASE_SCOPE });
    expect(await requestedScope(USER)).toBeNull();
  });

  test("re-requesting the same pending expansion is idempotent", async () => {
    await setScopeSettingsHandler({}, { did: USER }, { scope: SEMBLE_SCOPE });
    await setScopeSettingsHandler({}, { did: USER }, { scope: SEMBLE_SCOPE });
    expect(await requestedScope(USER)).toBe(SEMBLE_SCOPE);
  });

  test("recording a confirmed grant clears the pending expansion", async () => {
    await setScopeSettingsHandler({}, { did: USER }, { scope: SEMBLE_SCOPE });
    expect(await requestedScope(USER)).toBe(SEMBLE_SCOPE);

    // The PDS consent round-trip succeeds: recordScopeGrant writes the
    // confirmed grant, which becomes the source of truth.
    await recordScopeGrantHandler({}, { did: USER }, { scope: SEMBLE_SCOPE });
    expect(await storedScope(USER)).toBe(SEMBLE_SCOPE);
    expect(await requestedScope(USER)).toBeNull();

    // getScopeSettings no longer reports a stale pending request.
    const res = await getScopeSettingsHandler({}, { did: USER });
    expect(res.scope).toBe(SEMBLE_SCOPE);
    expect(res.requestedScope).toBeNull();
  });
});
