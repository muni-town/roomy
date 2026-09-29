/**
 * HTTP-level coverage for the progressive-scope-expansion endpoints:
 *   - `space.roomy.auth.getLoginScope`   (query, UNAUTHENTICATED)
 *   - `space.roomy.auth.recordScopeGrant` (procedure, authenticated)
 *
 * These prove the *routing* claims Phase 1 makes: getLoginScope answers a
 * caller with NO auth header (the whole reason it exists — the client calls it
 * before it has a token), recordScopeGrant 401s anonymously, and both are
 * registered on the router. Handler logic itself is unit-tested in
 * `handlers/space.roomy.auth.scopeGrants.test.ts`.
 *
 * Handle→DID resolution hits DNS/HTTP, so `globalThis.fetch` is stubbed for
 * the `.well-known/atproto-did` probe (same hermetic pattern as
 * `profileEndpoints.test.ts`); appserver traffic passes through untouched.
 *
 * Run: bun test --cwd packages/appserver src/e2e/scopeEndpoints.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { startAppserver, readStateDb, type E2eContext } from "./helpers.ts";
import { ENDPOINT_RATE_LIMITS } from "../xrpc/rateLimit.ts";

const USER = "did:plc:e2e-scope-user";
const HANDLE = "scope-e2e.example";
const RESOLVED_DID = "did:plc:scopee2eresolved";
const SCOPE = "atproto rpc:space.roomy.space.getSpaces blob:*/*";

const realFetch = globalThis.fetch;

/** Answer the HTTP handle-resolution probe for HANDLE. Everything else passes through. */
function stubHandleResolution(did: string | null): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(".well-known/atproto-did")) {
      return Promise.resolve(new Response(did ?? "not-a-did"));
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function loginScopeUrl(ctx: E2eContext, handle = HANDLE): string {
  return `${ctx.baseUrl}/xrpc/space.roomy.auth.getLoginScope?handle=${encodeURIComponent(handle)}`;
}

describe("space.roomy.auth.getLoginScope (HTTP)", () => {
  test("answers a caller with NO auth header", async () => {
    stubHandleResolution(RESOLVED_DID);
    const ctx = await startAppserver();

    // anonFetch sends no X-Test-Did — the router resolves this to did: null.
    const res = await ctx.anonFetch(loginScopeUrl(ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: RESOLVED_DID, scope: null });
  });

  test("returns the stored scope for a previously-consented user, anonymously", async () => {
    stubHandleResolution(RESOLVED_DID);
    const ctx = await startAppserver();

    readStateDb(ctx.db).run(
      "insert into user_oauth_grants (user_did, granted_scope, updated_at) values (?, ?, ?)",
      [RESOLVED_DID, SCOPE, Date.now()],
    );

    const res = await ctx.anonFetch(loginScopeUrl(ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ did: RESOLVED_DID, scope: SCOPE });
  });

  test("400 on missing handle", async () => {
    stubHandleResolution(RESOLVED_DID);
    const ctx = await startAppserver();

    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.auth.getLoginScope`,
    );
    expect(res.status).toBe(400);
  });

  test("404 when the handle does not resolve", async () => {
    stubHandleResolution(null);
    const ctx = await startAppserver();

    const res = await ctx.anonFetch(loginScopeUrl(ctx));
    expect(res.status).toBe(404);
  });
  test("router enforces the tighter per-endpoint limit (429 past budget)", async () => {
    stubHandleResolution(RESOLVED_DID);
    const ctx = await startAppserver();
    const points = ENDPOINT_RATE_LIMITS["space.roomy.auth.getLoginScope"]!.points;

    // The budget is per-IP; the e2e server is reached over loopback, so the
    // same key is used for every request here.
    const statuses: number[] = [];
    for (let i = 0; i < points + 1; i++) {
      statuses.push((await ctx.anonFetch(loginScopeUrl(ctx))).status);
    }

    expect(statuses.slice(0, points)).toEqual(Array(points).fill(200));
    expect(statuses[points]).toBe(429);
  });
});

describe("space.roomy.auth.recordScopeGrant (HTTP)", () => {
  test("authenticated caller records a grant that getLoginScope then returns", async () => {
    stubHandleResolution(RESOLVED_DID);
    const ctx = await startAppserver();

    const res = await ctx.authedFetch(RESOLVED_DID)(
      `${ctx.baseUrl}/xrpc/space.roomy.auth.recordScopeGrant`,
      { method: "POST", body: JSON.stringify({ scope: SCOPE }) },
    );
    expect(res.status).toBe(200);

    const login = await ctx.anonFetch(loginScopeUrl(ctx));
    expect(await login.json()).toEqual({ did: RESOLVED_DID, scope: SCOPE });
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.auth.recordScopeGrant`,
      { method: "POST", body: JSON.stringify({ scope: SCOPE }) },
    );
    expect(res.status).toBe(401);
  });

  test("missing scope → 400", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.auth.recordScopeGrant`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(res.status).toBe(400);
  });

  test("repeated calls upsert to one row", async () => {
    const ctx = await startAppserver();
    const post = (scope: string) =>
      ctx.authedFetch(USER)(
        `${ctx.baseUrl}/xrpc/space.roomy.auth.recordScopeGrant`,
        { method: "POST", body: JSON.stringify({ scope }) },
      );

    expect((await post(SCOPE)).status).toBe(200);
    expect((await post("atproto")).status).toBe(200);

    const row = await readStateDb(ctx.db)
      .query(
        "select count(*) as n, max(granted_scope) as scope from user_oauth_grants where user_did = ?",
      )
      .get<{ n: number; scope: string }>(USER);
    expect(row?.n).toBe(1);
    expect(row?.scope).toBe("atproto");
  });
});
