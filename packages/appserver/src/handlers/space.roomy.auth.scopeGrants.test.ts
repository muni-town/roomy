/**
 * Unit tests for the progressive-scope-expansion handlers:
 *   - `space.roomy.auth.getLoginScope`   (query, UNAUTHENTICATED)
 *   - `space.roomy.auth.recordScopeGrant` (procedure, authenticated)
 *
 * Both read/write `user_oauth_grants` in the read-state DB, so these run with
 * in-memory DBs (no materialisation). Handle→DID resolution hits DNS/HTTP, so
 * `globalThis.fetch` is stubbed for the HTTP `.well-known/atproto-did`
 * fallback — same hermetic pattern as `e2e/profileEndpoints.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openReadStateDb } from "../db/db.ts";
import { getLoginScopeHandler } from "./space.roomy.auth.getLoginScope.ts";
import { recordScopeGrantHandler } from "./space.roomy.auth.recordScopeGrant.ts";

const USER = UserDid.assert("did:plc:scope-user");
const HANDLE = "scope-test.example";
const RESOLVED_DID = "did:plc:scoperesolved123";

/** Scope strings as `getTokenInfo()` returns them — raw, space-separated. */
const BASE_SCOPE = "atproto rpc:space.roomy.space.getSpaces blob:*/*";
const NARROWED_SCOPE = "atproto rpc:space.roomy.space.getSpaces";

const realFetch = globalThis.fetch;

/**
 * Answer the HTTP handle-resolution probe for HANDLE with RESOLVED_DID.
 * Everything else (including DNS, which fails fast for a fake TLD here) falls
 * through to the real transport.
 */
function stubHandleResolution(did: string | null): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(".well-known/atproto-did")) {
      return Promise.resolve(new Response(did ?? "not-a-did"));
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
}

async function grantRowCount(): Promise<number> {
  const row = await openReadStateDb()
    .query("select count(*) as n from user_oauth_grants")
    .get<{ n: number }>();
  return row?.n ?? 0;
}

async function storedScope(did: string): Promise<string | null> {
  const row = await openReadStateDb()
    .query("select granted_scope from user_oauth_grants where user_did = ?")
    .get<{ granted_scope: string }>(did);
  return row?.granted_scope ?? null;
}

beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
  stubHandleResolution(RESOLVED_DID);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  closeDb();
});

describe("space.roomy.auth.getLoginScope", () => {
  test("returns null scope when the user has no stored grant", async () => {
    const result = await getLoginScopeHandler({ handle: HANDLE }, { did: null });
    expect(result).toEqual({ did: RESOLVED_DID, scope: null });
  });

  test("returns the stored scope string when a grant exists", async () => {
    // Keyed by the RESOLVED did — the handle is only an input.
    await recordScopeGrantHandler({}, { did: RESOLVED_DID }, { scope: BASE_SCOPE });

    const result = await getLoginScopeHandler(
      { handle: HANDLE },
      { did: null },
    );
    expect(result.did).toBe(RESOLVED_DID);
    expect(result.scope).toBe(BASE_SCOPE);
  });

  test("works with NO auth (did null) — the whole point of the endpoint", async () => {
    // No row AND no token: must not throw AuthRequired.
    const result = await getLoginScopeHandler(
      { handle: HANDLE },
      { did: null },
    );
    expect(result.scope).toBeNull();
  });

  test("400 on missing handle", async () => {
    await expect(
      getLoginScopeHandler({}, { did: null }),
    ).rejects.toMatchObject({ status: 400, xrpcError: "InvalidRequest" });
  });

  test("400 on empty handle", async () => {
    await expect(
      getLoginScopeHandler({ handle: "" }, { did: null }),
    ).rejects.toMatchObject({ status: 400, xrpcError: "InvalidRequest" });
  });

  test("404 when the handle does not resolve", async () => {
    stubHandleResolution(null);
    await expect(
      getLoginScopeHandler({ handle: "no-such-handle.example" }, { did: null }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("looks up the RESOLVED did, not the handle string", async () => {
    await recordScopeGrantHandler({}, { did: RESOLVED_DID }, { scope: BASE_SCOPE });

    const result = await getLoginScopeHandler({ handle: HANDLE }, { did: null });
    expect(result.scope).toBe(BASE_SCOPE);
  });
});

describe("space.roomy.auth.recordScopeGrant", () => {
  test("401 when unauthenticated", async () => {
    await expect(
      recordScopeGrantHandler({}, { did: null }, { scope: BASE_SCOPE }),
    ).rejects.toMatchObject({ status: 401, xrpcError: "AuthRequired" });
  });

  test("400 on missing scope", async () => {
    await expect(
      recordScopeGrantHandler({}, { did: USER }, {}),
    ).rejects.toMatchObject({ status: 400, xrpcError: "InvalidRequest" });
  });

  test("400 on empty scope", async () => {
    await expect(
      recordScopeGrantHandler({}, { did: USER }, { scope: "" }),
    ).rejects.toMatchObject({ status: 400, xrpcError: "InvalidRequest" });
  });

  test("upserts: calling twice keeps one row with the updated value", async () => {
    await recordScopeGrantHandler({}, { did: USER }, { scope: BASE_SCOPE });
    expect(await grantRowCount()).toBe(1);
    expect(await storedScope(USER)).toBe(BASE_SCOPE);

    await recordScopeGrantHandler({}, { did: USER }, { scope: NARROWED_SCOPE });
    expect(await grantRowCount()).toBe(1);
    expect(await storedScope(USER)).toBe(NARROWED_SCOPE);
  });

  test("stores LAST-GRANTED, not a high-water mark (narrowing wins)", async () => {
    await recordScopeGrantHandler({}, { did: RESOLVED_DID }, { scope: BASE_SCOPE });
    await recordScopeGrantHandler(
      {},
      { did: RESOLVED_DID },
      { scope: NARROWED_SCOPE },
    );

    const result = await getLoginScopeHandler({ handle: HANDLE }, { did: null });
    expect(result.scope).toBe(NARROWED_SCOPE);
    expect(result.scope).not.toContain("blob:*/*");
  });

  test("stores the raw scope string verbatim (no tier interpretation)", async () => {
    const raw = "atproto rpc:a?aud=* repo:network.cosmik.card?action=create";
    await recordScopeGrantHandler({}, { did: USER }, { scope: raw });
    expect(await storedScope(USER)).toBe(raw);
  });

  test("separate users get separate rows", async () => {
    const other = UserDid.assert("did:plc:scope-other");
    await recordScopeGrantHandler({}, { did: USER }, { scope: BASE_SCOPE });
    await recordScopeGrantHandler({}, { did: other }, { scope: NARROWED_SCOPE });

    expect(await grantRowCount()).toBe(2);
    expect(await storedScope(USER)).toBe(BASE_SCOPE);
    expect(await storedScope(other)).toBe(NARROWED_SCOPE);
  });
});
