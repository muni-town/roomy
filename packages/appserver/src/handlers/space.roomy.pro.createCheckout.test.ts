/**
 * Unit tests for the createProCheckout handler
 * (space.roomy.pro.createCheckout).
 *
 * The handler mints a Polar checkout session bound to the caller's DID as
 * the customer external ID. All Polar fetches are stubbed — real Polar is
 * never hit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { Router } from "../invalidation/router.ts";
import { _clearPolarCache, setPolar, type PolarConfig } from "../billing/polar.ts";
import { createProCheckoutHandler } from "./space.roomy.pro.createCheckout.ts";
import { XrpcError } from "../xrpc/errors.ts";

const USER = "did:plc:pro-buyer";

const CONFIG: PolarConfig = {
  endpoint: "https://sandbox-api.polar.sh/v1",
  accessToken: "polar_oat_test",
  roomyProProductId: "prod_roomy_pro",
  appOrigin: "https://roomy.space",
};

const realFetch = globalThis.fetch;

/** Stub ONLY Polar API fetches; capture the request body for assertions. */
function stubPolar(body: unknown, status = 201): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/checkouts/")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }
    return Promise.resolve(
      status === 201
        ? Response.json({ id: "chk_abc", url: "https://buy.polar.sh/session/def" }, { status: 201 })
        : new Response("nope", { status: status }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { bodies };
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

describe("createProCheckoutHandler", () => {
  test("mints checkout bound to caller DID, returns checkout URL", async () => {
    const { bodies } = stubPolar(null);
    const res = await createProCheckoutHandler({}, auth(USER), {});
    expect(res.checkoutUrl).toBe("https://buy.polar.sh/session/def");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      products: [CONFIG.roomyProProductId],
      external_customer_id: USER,
      success_url: "https://roomy.space/user/settings/subscription?checkout={CHECKOUT_ID}",
    });
  });

  test("anonymous → 401", async () => {
    try {
      await createProCheckoutHandler({}, auth(null), {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(401);
    }
  });

  test("Polar disabled → 503", async () => {
    setPolar(null);
    try {
      await createProCheckoutHandler({}, auth(USER), {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(503);
    }
  });

  test("Polar checkout creation failure → 503 (no session possible)", async () => {
    stubPolar(null, 422);
    try {
      await createProCheckoutHandler({}, auth(USER), {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(503);
    }
  });
});
