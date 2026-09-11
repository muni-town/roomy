/**
 * Unit tests for the getMembershipStatus handler (space.roomy.user.getMembershipStatus).
 *
 * The handler resolves the caller's Roomy Pro capacity from Polar
 * (TTL-cached, fail-open) and reports isPro/capacity/stale. The `checkout`
 * param forces a non-cached refresh so a just-completed Polar checkout is
 * visible immediately.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { Router } from "../invalidation/router.ts";
import { _clearPolarCache, setPolar, type PolarConfig } from "../billing/polar.ts";
import { getMembershipStatusHandler } from "./space.roomy.user.getMembershipStatus.ts";
import { XrpcError } from "../xrpc/errors.ts";

const USER = "did:plc:pro-user";

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

function stubPolar(state: unknown, status = 200): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      status === 404
        ? new Response("", { status: 404 })
        : Response.json(state, { status }),
    )) as unknown as typeof globalThis.fetch;
}

function resetFetch(): void {
  globalThis.fetch = realFetch;
}

function auth(did: string | null) {
  return { did };
}

beforeEach(() => {
  closeDb();
  _resetHydrationInflight();
  Router.resetInstance();
  _clearPolarCache();
  setPolar(CONFIG);
  openDb({ path: ":memory:" });
});

afterEach(() => {
  resetFetch();
  setPolar(null);
  closeDb();
  _resetHydrationInflight();
  Router.resetInstance();
});

describe("getMembershipStatusHandler", () => {
  test("Pro member → isPro true, capacity 1000", async () => {
    stubPolar(proState());
    const res = await getMembershipStatusHandler({}, auth(USER));
    expect(res.isPro).toBe(true);
    expect(res.capacity).toBe(1000);
    expect(res.stale).toBe(false);
    expect(res.checkedAt).toBeTypeOf("number");
  });

  test("no customer → isPro false, capacity 0", async () => {
    stubPolar(noCustomer());
    const res = await getMembershipStatusHandler({}, auth(USER));
    expect(res.isPro).toBe(false);
    expect(res.capacity).toBe(0);
    expect(res.stale).toBe(false);
  });

  test("anonymous → 401", async () => {
    try {
      await getMembershipStatusHandler({}, auth(null));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(401);
    }
  });

  test("Polar disabled → 503", async () => {
    setPolar(null);
    try {
      await getMembershipStatusHandler({}, auth(USER));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(503);
    }
  });

  test("checkout param forces a non-cached refresh (sees new sub immediately)", async () => {
    let fetches = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetches += 1;
      return Promise.resolve(
        fetches === 1
          ? Response.json(noCustomer(), { status: 200 })
          : Response.json(proState(), { status: 200 }),
      );
    }) as unknown as typeof globalThis.fetch;

    // First read: not a member (cached).
    const before = await getMembershipStatusHandler({}, auth(USER));
    expect(before.isPro).toBe(false);

    // TTL-fresh cache would still say 0; the checkout param forces a
    // refetch that sees the new subscription.
    const after = await getMembershipStatusHandler({ checkout: "checkout_123" }, auth(USER));
    expect(after.isPro).toBe(true);
    expect(after.capacity).toBe(1000);
    expect(fetches).toBe(2);
  });

  test("Polar outage with cached state → stale:true, never capacity 0 from unknown", async () => {
    let fetches = 0;
    globalThis.fetch = (() => {
      fetches += 1;
      return Promise.resolve(
        fetches === 1
          ? Response.json(proState(), { status: 200 })
          : new Response("boom", { status: 500 }),
      );
    }) as unknown as typeof globalThis.fetch;

    // Prime the cache with a valid Pro state.
    const first = await getMembershipStatusHandler({}, auth(USER));
    expect(first.isPro).toBe(true);

    // Forced read hits the outage → fail-open on the cached state.
    const second = await getMembershipStatusHandler({ checkout: "checkout_456" }, auth(USER));
    expect(second.isPro).toBe(true);
    expect(second.capacity).toBe(1000);
    expect(second.stale).toBe(true);
  });
});
