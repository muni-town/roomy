/**
 * Unit tests for the Polar billing client (src/billing/polar.ts) and the
 * capacity resolution (src/billing/capacity.ts).
 *
 * All fetch traffic is stubbed — real Polar is never hit in tests.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  _clearPolarCache,
  _expirePolarCache,
  createCheckoutSession,
  getCachedCustomerState,
  getCustomerState,
  getPolarConfig,
  resolveCapacity,
  ROOMY_PRO_CAPACITY,
  PolarUnavailableError,
  type PolarConfig,
  type PolarCustomerState,
} from "./polar.ts";
import { resolveGrantorCapacityWith } from "./capacity.ts";

const CONFIG: PolarConfig = {
  endpoint: "https://sandbox-api.polar.sh/v1",
  accessToken: "polar_oat_test",
  roomyProProductId: "prod_roomy_pro",
  appOrigin: "https://roomy.space",
};

function polarState(partial?: Partial<PolarCustomerState>): PolarCustomerState {
  return {
    active_subscriptions: [],
    granted_benefits: [],
    ...partial,
  };
}

function sub(partial?: Partial<{ status: string; product_id: string; cancel_at_period_end: boolean }>) {
  return {
    status: "active",
    product_id: CONFIG.roomyProProductId,
    cancel_at_period_end: false,
    ...partial,
  } as PolarCustomerState["active_subscriptions"][number];
}

// ─── fetch stubbing ───────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** Stub global fetch; `handler` receives the request and returns a Response. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof globalThis.fetch;
}

function resetFetch(): void {
  globalThis.fetch = realFetch;
}

afterEach(() => {
  resetFetch();
  _clearPolarCache();
});

// ─── config parsing ───────────────────────────────────────────────────────

describe("getPolarConfig", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  test("reads POLAR_ACCESS_TOKEN + ROOMY_PRO_PRODUCT_ID + endpoint default", () => {
    process.env.POLAR_ACCESS_TOKEN = "polar_oat_x";
    process.env.ROOMY_PRO_PRODUCT_ID = "prod_x";
    delete process.env.POLAR_ENDPOINT;
    delete process.env.ROOMY_APP_ORIGIN;
    const cfg = getPolarConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.endpoint).toBe("https://api.polar.sh/v1");
    expect(cfg?.accessToken).toBe("polar_oat_x");
    expect(cfg?.roomyProProductId).toBe("prod_x");
    expect(cfg?.appOrigin).toBe("https://roomy.space");
  });

  test("honors ROOMY_APP_ORIGIN + strips trailing slash", () => {
    process.env.POLAR_ACCESS_TOKEN = "polar_oat_x";
    process.env.ROOMY_PRO_PRODUCT_ID = "prod_x";
    process.env.ROOMY_APP_ORIGIN = "https://app.roomy.space/";
    expect(getPolarConfig()?.appOrigin).toBe("https://app.roomy.space");
  });

  test("honors POLAR_ENDPOINT + strips trailing slash", () => {
    process.env.POLAR_ACCESS_TOKEN = "polar_oat_x";
    process.env.ROOMY_PRO_PRODUCT_ID = "prod_x";
    process.env.POLAR_ENDPOINT = "https://sandbox-api.polar.sh/v1/";
    expect(getPolarConfig()?.endpoint).toBe("https://sandbox-api.polar.sh/v1");
  });

  test("missing token → null (provider disabled)", () => {
    process.env.POLAR_ACCESS_TOKEN = "";
    process.env.ROOMY_PRO_PRODUCT_ID = "prod_x";
    expect(getPolarConfig()).toBeNull();
  });

  test("missing product id → null (provider disabled)", () => {
    process.env.POLAR_ACCESS_TOKEN = "polar_oat_x";
    delete process.env.ROOMY_PRO_PRODUCT_ID;
    expect(getPolarConfig()).toBeNull();
  });
});

// ─── getCustomerState (raw fetch) ─────────────────────────────────────────

describe("getCustomerState", () => {
  test("200 with a valid state → typed state", async () => {
    const state = polarState({
      active_subscriptions: [sub()],
    });
    stubFetch(() =>
      Response.json(state, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await getCustomerState("did:plc:user", CONFIG)).toEqual(state);
  });

  test("sends the Bearer org access token", async () => {
    let seenAuth: string | null = null;
    stubFetch((url, init) => {
      expect(url).toContain(
        "/customers/external/did%3Aplc%3Auser/state",
      );
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      return Response.json(
        polarState(),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await getCustomerState("did:plc:user", CONFIG);
    expect(seenAuth as string | null).toBe("Bearer polar_oat_test");
  });

  test("404 → null (no customer, definitive capacity 0)", async () => {
    stubFetch(() => new Response("Not found", { status: 404 }));
    expect(await getCustomerState("did:plc:nobody", CONFIG)).toBeNull();
  });

  test("500 → PolarUnavailableError", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    await expect(
      getCustomerState("did:plc:user", CONFIG),
    ).rejects.toBeInstanceOf(PolarUnavailableError);
  });

  test("network error → PolarUnavailableError", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(
      getCustomerState("did:plc:user", CONFIG),
    ).rejects.toBeInstanceOf(PolarUnavailableError);
  });

  test("malformed 200 body → PolarUnavailableError", async () => {
    stubFetch(() =>
      Response.json({ nope: true }, { status: 200 }),
    );
    await expect(
      getCustomerState("did:plc:user", CONFIG),
    ).rejects.toBeInstanceOf(PolarUnavailableError);
  });
});

// ─── capacity resolution ──────────────────────────────────────────────────

describe("resolveCapacity", () => {
  test("Roomy Pro subscription (active) → 1000", () => {
    const state = polarState({
      active_subscriptions: [sub({ status: "active" })],
    });
    expect(resolveCapacity(state, CONFIG)).toEqual({
      capacity: ROOMY_PRO_CAPACITY,
      stale: false,
    });
  });

  test("Roomy Pro subscription (trialing) → 1000", () => {
    const state = polarState({
      active_subscriptions: [sub({ status: "trialing" })],
    });
    expect(resolveCapacity(state, CONFIG).capacity).toBe(ROOMY_PRO_CAPACITY);
  });

  test("no subscriptions, no benefits → 0", () => {
    expect(resolveCapacity(polarState(), CONFIG).capacity).toBe(0);
  });

  test("non-Pro subscription → 0", () => {
    const state = polarState({
      active_subscriptions: [sub({ product_id: "prod_other" })],
    });
    expect(resolveCapacity(state, CONFIG).capacity).toBe(0);
  });

  test("feature_flag benefit with max_members overrides Pro → max wins", () => {
    const state = polarState({
      active_subscriptions: [sub({ status: "active" })],
      granted_benefits: [
        {
          benefit_type: "feature_flag",
          benefit_metadata: { max_members: 5000 },
        },
      ],
    });
    expect(resolveCapacity(state, CONFIG).capacity).toBe(5000);
  });

  test("max_members below Pro still yields the max (1000)", () => {
    const state = polarState({
      active_subscriptions: [sub({ status: "active" })],
      granted_benefits: [
        {
          benefit_type: "feature_flag",
          benefit_metadata: { max_members: 250 },
        },
      ],
    });
    expect(resolveCapacity(state, CONFIG).capacity).toBe(ROOMY_PRO_CAPACITY);
  });

  test("only custom max_members benefit → that value", () => {
    const state = polarState({
      granted_benefits: [
        {
          benefit_type: "feature_flag",
          benefit_metadata: { max_members: 500 },
        },
      ],
    });
    expect(resolveCapacity(state, CONFIG).capacity).toBe(500);
  });

  test("non-feature_flag benefits are ignored", () => {
    const state = polarState({
      granted_benefits: [
        { benefit_type: "articles", benefit_metadata: { max_members: 9999 } },
      ],
    });
    expect(resolveCapacity(state, CONFIG).capacity).toBe(0);
  });

  test("missing/string/bool max_members are ignored or coerced", () => {
    expect(
      resolveCapacity(
        polarState({
          granted_benefits: [
            { benefit_type: "feature_flag", benefit_metadata: {} },
          ],
        }),
        CONFIG,
      ).capacity,
    ).toBe(0);
    // Numeric string metadata (Polar may deliver strings) is coerced.
    expect(
      resolveCapacity(
        polarState({
          granted_benefits: [
            {
              benefit_type: "feature_flag",
              benefit_metadata: { max_members: "750" },
            },
          ],
        }),
        CONFIG,
      ).capacity,
    ).toBe(750);
    expect(
      resolveCapacity(
        polarState({
          granted_benefits: [
            {
              benefit_type: "feature_flag",
              benefit_metadata: { max_members: true },
            },
          ],
        }),
        CONFIG,
      ).capacity,
    ).toBe(0);
  });
});

// ─── cached client (fail-open) ────────────────────────────────────────────

describe("getCachedCustomerState / resolveGrantorCapacityWith", () => {
  const DID = "did:plc:cached-user";

  test("caches state for the 300s TTL (single fetch for two reads)", async () => {
    let fetches = 0;
    const state = polarState({
      active_subscriptions: [sub({ status: "active" })],
    });
    stubFetch(() => {
      fetches += 1;
      return Response.json(state, { status: 200 });
    });

    const first = await getCachedCustomerState(DID, CONFIG);
    const second = await getCachedCustomerState(DID, CONFIG);
    expect(fetches).toBe(1);
    expect(first).toEqual({ state, stale: false });
    expect(second).toEqual({ state, stale: false });
  });

  test("5xx after a cached state → serve cached with stale:true (fail-open)", async () => {
    const state = polarState({
      active_subscriptions: [sub({ status: "active" })],
    });
    let fetches = 0;
    stubFetch(() => {
      fetches += 1;
      if (fetches === 1) return Response.json(state, { status: 200 });
      return new Response("boom", { status: 500 });
    });

    const first = await getCachedCustomerState(DID, CONFIG);
    expect(first).toEqual({ state, stale: false });

    // Age the cache entry out so the next read refetches — and fails.
    _expirePolarCache(DID);
    const refreshed = await getCachedCustomerState(DID, CONFIG);
    expect(refreshed).toEqual({ state, stale: true });
    expect(fetches).toBe(2);
  });

  test("404 is a definitive capacity 0 and is cached (refetch succeeds after outage)", async () => {
    let fetches = 0;
    stubFetch(() => {
      fetches += 1;
      if (fetches === 1) return new Response("", { status: 404 });
      return Response.json(
        polarState({ active_subscriptions: [sub({ status: "active" })] }),
        { status: 200 },
      );
    });

    const first = await getCachedCustomerState(DID, CONFIG);
    expect(first).toEqual({ state: null, stale: false });
    // TTL-fresh → cached 404 served, no second fetch.
    const second = await getCachedCustomerState(DID, CONFIG);
    expect(fetches).toBe(1);
    expect(second).toEqual({ state: null, stale: false });
  });

  test("no cache + fetch failure → PolarUnavailableError (nothing to fail open to)", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(
      getCachedCustomerState(DID, CONFIG),
    ).rejects.toBeInstanceOf(PolarUnavailableError);
  });

  test("resolveGrantorCapacityWith: valid Pro → 1000, stale=false", async () => {
    stubFetch(() =>
      Response.json(
        polarState({ active_subscriptions: [sub({ status: "active" })] }),
        { status: 200 },
      ),
    );
    expect(await resolveGrantorCapacityWith(CONFIG, DID)).toEqual({
      capacity: ROOMY_PRO_CAPACITY,
      stale: false,
    });
  });

  test("resolveGrantorCapacityWith: 404 → capacity 0", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    expect(await resolveGrantorCapacityWith(CONFIG, DID)).toEqual({
      capacity: 0,
      stale: false,
    });
  });

  test("force:true bypasses a TTL-fresh cache entry (refetches)", async () => {
    let fetches = 0;
    stubFetch(() => {
      fetches += 1;
      return Response.json(
        polarState({ active_subscriptions: [sub({ status: "active" })] }),
        { status: 200 },
      );
    });

    // Prime the cache (TTL-fresh).
    await getCachedCustomerState(DID, CONFIG);
    expect(fetches).toBe(1);

    // A normal read hits the cache; a forced read refetches.
    await getCachedCustomerState(DID, CONFIG);
    expect(fetches).toBe(1);
    const forced = await getCachedCustomerState(DID, CONFIG, { force: true });
    expect(fetches).toBe(2);
    expect(forced).toEqual({
      state: expect.objectContaining({ active_subscriptions: expect.any(Array) }),
      stale: false,
    });
  });

  test("force:true on refresh failure → cached state with stale:true (fail-open)", async () => {
    const state = polarState({
      active_subscriptions: [sub({ status: "active" })],
    });
    let fetches = 0;
    stubFetch(() => {
      fetches += 1;
      if (fetches === 1) return Response.json(state, { status: 200 });
      return new Response("boom", { status: 500 });
    });

    await getCachedCustomerState(DID, CONFIG);
    const forced = await getCachedCustomerState(DID, CONFIG, { force: true });
    expect(fetches).toBe(2);
    expect(forced).toEqual({ state, stale: true });
  });

  test("resolveGrantorCapacityWith force:true → fresh capacity after sub starts", async () => {
    let fetches = 0;
    stubFetch(() => {
      fetches += 1;
      if (fetches === 1) {
        // First read: not a member (cached).
        return Response.json(polarState(), { status: 200 });
      }
      // After checkout: Pro subscription active.
      return Response.json(
        polarState({ active_subscriptions: [sub({ status: "active" })] }),
        { status: 200 },
      );
    });

    const before = await resolveGrantorCapacityWith(CONFIG, DID);
    expect(before).toEqual({ capacity: 0, stale: false });

    // TTL-fresh cache would serve 0; force refetches and sees the sub.
    const after = await resolveGrantorCapacityWith(CONFIG, DID, { force: true });
    expect(after).toEqual({ capacity: ROOMY_PRO_CAPACITY, stale: false });
    expect(fetches).toBe(2);
  });
});

// ─── checkout-session creation ────────────────────────────────────────────

describe("createCheckoutSession", () => {
  const DID = "did:plc:buyer-user";
  const SUCCESS_URL = "https://roomy.space/user/settings/subscription?checkout={CHECKOUT_ID}";

  test("POSTs product + external_customer_id + success_url, returns id+url", async () => {
    let body: unknown;
    stubFetch((url, init) => {
      expect(url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer polar_oat_test");
      expect(headers["Content-Type"]).toBe("application/json");
      body = JSON.parse(String(init?.body));
      return Response.json({ id: "chk_123", url: "https://buy.polar.sh/session/abc" }, { status: 201 });
    });

    const session = await createCheckoutSession(CONFIG, {
      externalCustomerId: DID,
      successUrl: SUCCESS_URL,
    });

    expect(body).toEqual({
      products: [CONFIG.roomyProProductId],
      external_customer_id: DID,
      success_url: SUCCESS_URL,
    });
    expect(session).toEqual({ id: "chk_123", url: "https://buy.polar.sh/session/abc" });
  });

  test("non-201 → PolarUnavailableError", async () => {
    stubFetch(() => new Response("nope", { status: 422 }));
    try {
      await createCheckoutSession(CONFIG, {
        externalCustomerId: DID,
        successUrl: SUCCESS_URL,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PolarUnavailableError);
    }
  });

  test("malformed body → PolarUnavailableError", async () => {
    stubFetch(() => Response.json({ id: "chk_123" }, { status: 201 }));
    try {
      await createCheckoutSession(CONFIG, {
        externalCustomerId: DID,
        successUrl: SUCCESS_URL,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PolarUnavailableError);
    }
  });

  test("network failure → PolarUnavailableError", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    try {
      await createCheckoutSession(CONFIG, {
        externalCustomerId: DID,
        successUrl: SUCCESS_URL,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PolarUnavailableError);
    }
  });
});
