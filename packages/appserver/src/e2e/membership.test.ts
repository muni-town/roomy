/**
 * E2E tests for the Roomy Pro bridge-token endpoints:
 *
 *   - space.roomy.space.grantBridgeToken      (procedure)
 *   - space.roomy.space.revokeBridgeToken     (procedure)
 *   - space.roomy.space.getBridgeTokens       (query)
 *   - space.roomy.admin.getSpaceMembership    (query, admin-only)
 *
 * Polar fetches are stubbed at the fetch boundary (never hit real Polar in
 * tests). The admin allowlist is set to the ADMIN DID via _setAdminDids.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { startAppserver, seedSpace, seedUser, spaceDb as routedSpaceDb, type E2eContext } from "./helpers.ts";
import { _setAdminDids } from "../admin.ts";
import { _clearPolarCache, setPolar, type PolarConfig } from "../billing/polar.ts";

const ADMIN = "did:plc:e2e-admin";
const GRANTOR = "did:plc:e2e-grantor";
const MEMBER = "did:plc:e2e-member";
const OUTSIDER = "did:plc:e2e-outsider";
const SPACE = "did:web:e2e-bridge-space.example";

_setAdminDids([ADMIN]);

const CONFIG: PolarConfig = {
  endpoint: "https://sandbox-api.polar.sh/v1",
  accessToken: "polar_oat_test",
  roomyProProductId: "prod_roomy_pro",
  appOrigin: "https://roomy.space",
};

function proState() {
  return {
    active_subscriptions: [
      {
        status: "active",
        product_id: CONFIG.roomyProProductId,
        cancel_at_period_end: false,
      },
    ],
    granted_benefits: [],
  };
}

function noCustomer() {
  return { active_subscriptions: [], granted_benefits: [] };
}

const realFetch = globalThis.fetch;

/** Stub ONLY Polar API fetches; everything else (the test's own appserver
 *  HTTP calls) passes through to the real transport. */
function stubPolarState(state: unknown): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/customers/external/")) {
      return Response.json(state, { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
}

function resetFetch(): void {
  globalThis.fetch = realFetch;
}

afterEach(() => {
  resetFetch();
  setPolar(null);
  _clearPolarCache();
});

/** Seed the three test users so membership FKs resolve globally. */
function seedUsers(ctx: E2eContext): void {
  for (const u of [ADMIN, GRANTOR, MEMBER]) seedUser(ctx.db, u);
}

/** Seed a forward membership edge (head=space, tail=user) — the direction
 * the member-count + access queries read. Also seeds the user entity so the
 * edge FK resolves. */
function addMember(ctx: E2eContext, spaceId: string, userDid: string): void {
  const sp = routedSpaceDb(ctx.db, spaceId);
  sp.run(
    "insert or ignore into entities (id, stream_id) values (?, ?)",
    [userDid, userDid],
  );
  sp.run(
    `insert or ignore into edges (head, tail, label) values (?, ?, 'member')`,
    [spaceId, userDid],
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** Seed the space + grantor as a member (admin edge not needed). */
function seedSpaceWithMember(ctx: E2eContext): void {
  seedUsers(ctx);
  seedSpace(ctx.db as AnyDb, SPACE, GRANTOR, { allowPublicJoin: 0 });
  // MEMBER is also a member (reads getBridgeTokens / revoke 403 paths).
  addMember(ctx, SPACE, MEMBER);
}

function grantUrl(ctx: E2eContext): string {
  return `${ctx.baseUrl}/xrpc/space.roomy.space.grantBridgeToken`;
}

/** Start the appserver with Polar configured (tests that stub Polar). */
async function startTest(): Promise<E2eContext> {
  const ctx = await startAppserver();
  setPolar(CONFIG);
  return ctx;
}

function revokeUrl(ctx: E2eContext): string {
  return `${ctx.baseUrl}/xrpc/space.roomy.space.revokeBridgeToken`;
}

function tokensUrl(ctx: E2eContext, spaceId: string): string {
  return `${ctx.baseUrl}/xrpc/space.roomy.space.getBridgeTokens?spaceId=${encodeURIComponent(spaceId)}`;
}

function membershipUrl(ctx: E2eContext, spaceId: string): string {
  return `${ctx.baseUrl}/xrpc/space.roomy.admin.getSpaceMembership?spaceId=${encodeURIComponent(spaceId)}`;
}

function grantBody(spaceId: string) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId }),
  };
}

// ─── Polar must be configured for any bridge-token endpoint ───────────────

describe("bridge tokens: Polar disabled", () => {
  test("grant → 503 (Polar not configured)", async () => {
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    setPolar(null);
    const res = await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));
    expect(res.status).toBe(503);
  });

  test("admin getSpaceMembership → 503 (Polar not configured)", async () => {
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    setPolar(null);
    const res = await ctx.authedFetch(ADMIN)(membershipUrl(ctx, SPACE));
    expect(res.status).toBe(503);
  });
});

// ─── grantBridgeToken ─────────────────────────────────────────────────────

describe("space.roomy.space.grantBridgeToken", () => {
  test("Pro grantor grants → pending with capacity 1000; getBridgeTokens lists it", async () => {
    stubPolarState(proState());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);

    const res = await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "pending", capacity: 1000 });

    // getBridgeTokens (member) shows the grant.
    const list = await ctx.authedFetch(MEMBER)(tokensUrl(ctx, SPACE));
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.tokens).toHaveLength(1);
    expect(listBody.tokens[0]).toEqual({
      grantorDid: GRANTOR,
      spent: false,
      capacitySnapshot: 1000,
    });
  });

  test("anonymous → 401", async () => {
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    const res = await ctx.anonFetch(grantUrl(ctx), grantBody(SPACE));
    expect(res.status).toBe(401);
  });

  test("non-member → 403", async () => {
    stubPolarState(proState());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    // OUTSIDER is not a member of the space (unlike MEMBER, which reads
    // getBridgeTokens and exercises the revoke non-grantor path).
    const res = await ctx.authedFetch(OUTSIDER)(grantUrl(ctx), grantBody(SPACE));
    expect(res.status).toBe(403);
  });

  test("non-Pro (no customer) → 403 not a Pro member", async () => {
    stubPolarState(noCustomer());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    const res = await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("NotProMember");
  });

  test("second grant while pending → 409; revoke then re-grant succeeds", async () => {
    stubPolarState(proState());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);

    const first = await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));
    expect(first.status).toBe(200);

    // Pending grant exists → 409.
    const second = await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.error).toBe("AlreadyGranted");

    // Revoke frees the slot.
    const revoke = await ctx.authedFetch(GRANTOR)(
      revokeUrl(ctx),
      grantBody(SPACE),
    );
    expect(revoke.status).toBe(200);

    // Re-grant works (one active grant per user again).
    const third = await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));
    expect(third.status).toBe(200);
  });
});

// ─── revokeBridgeToken ────────────────────────────────────────────────────

describe("space.roomy.space.revokeBridgeToken", () => {
  test("anonymous → 401", async () => {
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    const res = await ctx.anonFetch(revokeUrl(ctx), grantBody(SPACE));
    expect(res.status).toBe(401);
  });

  test("non-grantor member → 403", async () => {
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    addMember(ctx, SPACE, MEMBER);
    const res = await ctx.authedFetch(MEMBER)(revokeUrl(ctx), grantBody(SPACE));
    expect(res.status).toBe(403);
  });

  test("revoke removes the grant row", async () => {
    stubPolarState(proState());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);

    await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));
    const revoke = await ctx.authedFetch(GRANTOR)(
      revokeUrl(ctx),
      grantBody(SPACE),
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: true });

    const list = await ctx.authedFetch(MEMBER)(tokensUrl(ctx, SPACE));
    expect((await list.json()).tokens).toHaveLength(0);
  });
});

// ─── admin getSpaceMembership ─────────────────────────────────────────────

describe("space.roomy.admin.getSpaceMembership", () => {
  test("anonymous → 403, non-admin → 403", async () => {
    stubPolarState(proState());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);

    const anon = await ctx.anonFetch(membershipUrl(ctx, SPACE));
    expect(anon.status).toBe(403);

    const nonAdmin = await ctx.authedFetch(MEMBER)(membershipUrl(ctx, SPACE));
    expect(nonAdmin.status).toBe(403);
  });

  test("happy path: pending grant → live capacity, maxMembers", async () => {
    stubPolarState(proState());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);

    await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));

    const res = await ctx.authedFetch(ADMIN)(membershipUrl(ctx, SPACE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spaceDid).toBe(SPACE);
    // Grantor + MEMBER are both members.
    expect(body.memberCount).toBe(2);
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toEqual({
      grantorDid: GRANTOR,
      capacity: 1000,
      status: "pending",
      live: true,
    });
    expect(body.validTokenCount).toBe(1);
    expect(body.maxMembers).toBe(1000);
    expect(body.overLimit).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.checkedAt).toBeTypeOf("number");
  });

  test("spend at 101 members: >100 marks the token spent permanently", async () => {
    stubPolarState(proState());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    await ctx.authedFetch(GRANTOR)(grantUrl(ctx), grantBody(SPACE));

    // 99 more members → 101 total (grantor + MEMBER + 99 extras).
    for (let i = 0; i < 99; i++) {
      addMember(ctx, SPACE, `did:plc:e2e-extra-${i}`);
    }

    const res = await ctx.authedFetch(ADMIN)(membershipUrl(ctx, SPACE));
    const body = await res.json();
    expect(body.memberCount).toBe(101);
    expect(body.tokens[0]).toEqual({
      grantorDid: GRANTOR,
      capacity: 0,
      status: "spent",
      live: false,
    });
    expect(body.maxMembers).toBe(0);
    expect(body.overLimit).toBe(true);

    // Spent is permanent: getBridgeTokens reports spent, revoke → 409,
    // grant → 409.
    const list = await ctx.authedFetch(MEMBER)(tokensUrl(ctx, SPACE));
    expect((await list.json()).tokens[0].spent).toBe(true);

    const revoke = await ctx.authedFetch(GRANTOR)(
      revokeUrl(ctx),
      grantBody(SPACE),
    );
    expect(revoke.status).toBe(409);

    const regrant = await ctx.authedFetch(GRANTOR)(
      grantUrl(ctx),
      grantBody(SPACE),
    );
    expect(regrant.status).toBe(409);
    expect((await regrant.json()).error).toBe("AlreadySpent");
  });
});

// ─── space.roomy.user.getMembershipStatus ────────────────────────────────────────

describe("space.roomy.user.getMembershipStatus", () => {
  function proStatusUrl(ctx: E2eContext, checkout?: string): string {
    const q = checkout ? `?checkout=${encodeURIComponent(checkout)}` : "";
    return `${ctx.baseUrl}/xrpc/space.roomy.user.getMembershipStatus${q}`;
  }

  test("Pro member → isPro true, capacity 1000", async () => {
    stubPolarState(proState());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);

    const res = await ctx.authedFetch(GRANTOR)(proStatusUrl(ctx));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isPro).toBe(true);
    expect(body.capacity).toBe(1000);
    expect(body.stale).toBe(false);
    expect(body.checkedAt).toBeTypeOf("number");
  });

  test("no customer → isPro false, capacity 0", async () => {
    stubPolarState(noCustomer());
    const ctx = await startTest();
    seedSpaceWithMember(ctx);

    const res = await ctx.authedFetch(GRANTOR)(proStatusUrl(ctx));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isPro).toBe(false);
    expect(body.capacity).toBe(0);
  });

  test("anonymous → 401", async () => {
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    const res = await ctx.anonFetch(proStatusUrl(ctx));
    expect(res.status).toBe(401);
  });

  test("Polar disabled → 503", async () => {
    const ctx = await startTest();
    seedSpaceWithMember(ctx);
    setPolar(null);
    const res = await ctx.authedFetch(GRANTOR)(proStatusUrl(ctx));
    expect(res.status).toBe(503);
  });

  test("checkout param forces a non-cached refresh (sees new sub immediately)", async () => {
    let fetches = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/customers/external/")) {
        fetches += 1;
        return Response.json(
          fetches === 1 ? noCustomer() : proState(),
          { status: 200 },
        );
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;

    const ctx = await startTest();
    seedSpaceWithMember(ctx);

    // First read: not a member (cached).
    const before = await ctx.authedFetch(GRANTOR)(proStatusUrl(ctx));
    expect((await before.json()).isPro).toBe(false);

    // TTL-fresh cache would still say 0; the checkout param forces a
    // refetch that sees the new subscription.
    const after = await ctx.authedFetch(GRANTOR)(
      proStatusUrl(ctx, "checkout_abc"),
    );
    expect(after.status).toBe(200);
    const body = await after.json();
    expect(body.isPro).toBe(true);
    expect(body.capacity).toBe(1000);
    expect(fetches).toBe(2);
  });
});

// ─── space.roomy.pro.createCheckout ────────────────────────────────────────

describe("space.roomy.pro.createCheckout", () => {
  function checkoutUrl(ctx: E2eContext): string {
    return `${ctx.baseUrl}/xrpc/space.roomy.pro.createCheckout`;
  }

  test("mints a Polar session bound to caller DID as external_customer_id", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/checkouts/")) {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(
          { id: "chk_e2e", url: "https://buy.polar.sh/session/e2e" },
          { status: 201 },
        );
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;

    const ctx = await startTest();
    const res = await ctx.authedFetch(GRANTOR)(checkoutUrl(ctx), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkoutUrl).toBe("https://buy.polar.sh/session/e2e");
    expect(requestBody).toEqual({
      products: [CONFIG.roomyProProductId],
      external_customer_id: GRANTOR,
      success_url:
        "https://roomy.space/user/settings/subscription?checkout={CHECKOUT_ID}",
    });
  });

  test("anonymous → 401", async () => {
    const ctx = await startTest();
    const res = await ctx.anonFetch(checkoutUrl(ctx), {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("Polar disabled → 503", async () => {
    const ctx = await startTest();
    setPolar(null);
    const res = await ctx.authedFetch(GRANTOR)(checkoutUrl(ctx), {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(503);
  });
});
