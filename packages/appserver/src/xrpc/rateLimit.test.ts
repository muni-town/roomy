import { beforeEach, describe, expect, test } from "bun:test";
import {
  ENDPOINT_RATE_LIMITS,
  _resetRateLimit,
  checkEndpointRateLimit,
  checkRateLimit,
  rateLimitResponse,
} from "./rateLimit.ts";

function req(url = "http://x/xrpc/test"): Request {
  return new Request(url);
}

function proxiedReq(ip: string, url = "http://x/xrpc/test"): Request {
  return new Request(url, {
    headers: { "x-forwarded-for": ip },
  });
}

describe("checkRateLimit", () => {
  test("allows requests under the limit", async () => {
    const result = await checkRateLimit(req(), "127.0.0.1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  test("ignores X-Forwarded-For when trust proxy is disabled", async () => {
    // With TRUST_PROXY=false (default), X-Forwarded-For is ignored and
    // the direct IP is used instead.
    const result = await checkRateLimit(proxiedReq("1.2.3.4"), "10.0.0.1");
    expect(result.allowed).toBe(true);
  });

  test("uses direct IP when trust proxy is disabled", async () => {
    const result = await checkRateLimit(req(), "10.0.0.1");
    expect(result.allowed).toBe(true);
  });

  test("different direct IPs get independent counters", async () => {
    const ip1 = "10.0.0.1";
    const ip2 = "10.0.0.2";

    const first = await checkRateLimit(req(), ip1);
    expect(first.remaining).toBeGreaterThan(0);

    // Exhaust the limit for ip1.
    let last: Awaited<ReturnType<typeof checkRateLimit>> = first;
    for (let i = 0; i < first.remaining; i++) {
      last = await checkRateLimit(req(), ip1);
    }
    expect(last.allowed).toBe(true);

    // ip1 should now be blocked.
    const blocked = await checkRateLimit(req(), ip1);
    expect(blocked.allowed).toBe(false);

    // ip2 should still be allowed because it has its own counter.
    const other = await checkRateLimit(req(), ip2);
    expect(other.allowed).toBe(true);
  });
});

describe("rateLimitResponse", () => {
  test("returns 429 with Retry-After header", async () => {
    const res = rateLimitResponse(5_000);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();

    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("RateLimitExceeded");
    expect(body.message).toContain("5 second(s)");
  });

  test("rounds up retry-after", () => {
    const res = rateLimitResponse(100);
    expect(res.headers.get("Retry-After")).toBe("1");
  });
});

describe("checkEndpointRateLimit", () => {
  const NSID = "space.roomy.auth.getLoginScope";

  beforeEach(() => {
    _resetRateLimit();
  });

  test("is a no-op for NSIDs with no configured limit", async () => {
    const result = await checkEndpointRateLimit(
      "space.roomy.space.getSpaces",
      req(),
      "10.1.1.1",
    );
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  test("allows requests under the limit and blocks over it", async () => {
    const points = ENDPOINT_RATE_LIMITS[NSID]!.points;
    const ip = "10.2.2.2";

    for (let i = 0; i < points; i++) {
      const r = await checkEndpointRateLimit(NSID, req(), ip);
      expect(r.allowed).toBe(true);
    }

    const blocked = await checkEndpointRateLimit(NSID, req(), ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("different IPs get independent counters", async () => {
    const points = ENDPOINT_RATE_LIMITS[NSID]!.points;
    const exhausted = "10.3.3.3";
    for (let i = 0; i < points; i++) {
      await checkEndpointRateLimit(NSID, req(), exhausted);
    }
    expect((await checkEndpointRateLimit(NSID, req(), exhausted)).allowed).toBe(
      false,
    );

    const other = await checkEndpointRateLimit(NSID, req(), "10.3.3.4");
    expect(other.allowed).toBe(true);
  });

  test("the endpoint limit is tighter than the global IP limit", async () => {
    // The point of a separate limiter: exhausting the endpoint budget must
    // not block ordinary traffic from the same IP (and vice versa). This is
    // the resolution-amplification guard for the unauthenticated
    // handle→DID query.
    const points = ENDPOINT_RATE_LIMITS[NSID]!.points;
    const ip = "10.4.4.4";
    for (let i = 0; i < points; i++) {
      await checkEndpointRateLimit(NSID, req(), ip);
    }
    expect((await checkEndpointRateLimit(NSID, req(), ip)).allowed).toBe(false);

    // Global budget untouched by the endpoint budget.
    const global = await checkRateLimit(req(), ip);
    expect(global.allowed).toBe(true);
    expect(global.remaining).toBeGreaterThan(0);
  });
});
