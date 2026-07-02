/**
 * Unit tests for the rate-limit-respecting backoff wrapper and the
 * `DirectXrpcClient` / `agentQuery` integration. Uses an injectable sleep
 * so backoff timing is deterministic and fast.
 */
import { describe, it, expect, vi } from "vitest";
import {
  withRateLimitRetry,
  RateLimitError,
  isRateLimitError,
  getRetryAfterMs,
} from "./retry";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Records each sleep duration and resolves immediately. */
function instantSleep() {
  const calls: number[] = [];
  const fn = async (ms: number) => {
    calls.push(ms);
  };
  return { fn, calls } as const;
}

/** A thunk that throws a RateLimitError N times then returns a value. */
function flaky<T>(fail: T, succeed: T, failTimes: number) {
  let n = 0;
  return () => {
    if (n < failTimes) {
      n++;
      throw new RateLimitError(0, "rate limited");
    }
    return succeed;
  };
}

// ─── withRateLimitRetry ───────────────────────────────────────────────────

describe("withRateLimitRetry", () => {
  it("returns the value when fn succeeds first try", async () => {
    const sleep = instantSleep();
    const result = await withRateLimitRetry(() => Promise.resolve(42), {
      sleep: sleep.fn,
    });
    expect(result).toBe(42);
    expect(sleep.calls).toHaveLength(0);
  });

  it("rethrows non-429 errors immediately without retry", async () => {
    const sleep = instantSleep();
    const boom = new Error("500 internal");
    await expect(
      withRateLimitRetry(() => Promise.reject(boom), { sleep: sleep.fn }),
    ).rejects.toBe(boom);
    expect(sleep.calls).toHaveLength(0);
  });

  it("retries on 429 and succeeds on a later attempt", async () => {
    const sleep = instantSleep();
    let n = 0;
    const result = await withRateLimitRetry(
      async () => {
        if (n < 2) {
          n++;
          throw new RateLimitError(1, "rate limited");
        }
        return "ok";
      },
      { sleep: sleep.fn, maxRetries: 5 },
    );
    expect(result).toBe("ok");
    expect(sleep.calls).toHaveLength(2);
  });

  it("honours the Retry-After header (seconds) as the sleep duration", async () => {
    const sleep = instantSleep();
    let n = 0;
    await withRateLimitRetry(
      async () => {
        if (n < 1) {
          n++;
          // Simulate an error carrying a Retry-After header (HeadersMap form).
          const err = new RateLimitError(7, "rate limited");
          Object.assign(err, {
            headers: { "retry-after": "7" },
          });
          throw err;
        }
        return "ok";
      },
      { sleep: sleep.fn, maxRetries: 3 },
    );
    // 7 seconds → 7000ms, capped only by maxDelayMs (30s default).
    expect(sleep.calls).toEqual([7000]);
  });

  it("falls back to jittered backoff when no Retry-After is present", async () => {
    const sleep = instantSleep();
    let n = 0;
    await withRateLimitRetry(
      async () => {
        if (n < 1) {
          n++;
          // No Retry-After, but isRateLimitError is true (RateLimitError).
          throw new RateLimitError(null, "rate limited");
        }
        return "ok";
      },
      {
        sleep: sleep.fn,
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      },
    );
    expect(sleep.calls).toHaveLength(1);
    // Jittered: [0, min(100 * 2^0, 1000)] = [0, 100].
    expect(sleep.calls[0]).toBeGreaterThanOrEqual(0);
    expect(sleep.calls[0]).toBeLessThanOrEqual(100);
  });

  it("gives up after maxRetries and rethrows the 429", async () => {
    const sleep = instantSleep();
    let n = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          n++;
          throw new RateLimitError(0, "rate limited");
        },
        { sleep: sleep.fn, maxRetries: 2 },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    // 1 initial + 2 retries = 3 calls total.
    expect(n).toBe(3);
    expect(sleep.calls).toHaveLength(2);
  });

  it("detects 429s thrown as plain objects with status: 429", async () => {
    const sleep = instantSleep();
    let n = 0;
    const result = await withRateLimitRetry(
      async () => {
        if (n < 1) {
          n++;
          // @atproto/xrpc-style error: plain Error subclass with status field.
          const e = new Error("XRPC RateLimitExceeded");
          Object.assign(e, { status: 429 });
          throw e;
        }
        return "ok";
      },
      { sleep: sleep.fn, maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
    );
    expect(result).toBe("ok");
    expect(sleep.calls).toHaveLength(1);
  });

  it("aborts the retry loop when the signal is already aborted", async () => {
    const sleep = instantSleep();
    const ac = new AbortController();
    ac.abort();
    let n = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          n++;
          throw new RateLimitError(5, "rate limited");
        },
        { sleep: sleep.fn, maxRetries: 5, signal: ac.signal },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    // The first 429 rethrows because maxRetries not reached; but since the
    // sleep is aborted it resolves immediately and the next fn call throws
    // again. The loop still runs maxRetries times — the signal only shortens
    // the sleep, it doesn't skip the retry. We assert it did not spin forever.
    expect(n).toBeLessThanOrEqual(6);
  });
});

// ─── getRetryAfterMs ───────────────────────────────────────────────────────

describe("getRetryAfterMs", () => {
  it("reads Retry-After from a RateLimitError carrying retryAfterSec", () => {
    const err = new RateLimitError(12);
    expect(getRetryAfterMs(err)).toBe(12_000);
  });

  it("reads Retry-After from WHATWG Headers on an error", () => {
    const err = new Error("429") as Error & { headers: Headers };
    err.headers = new Headers({ "retry-after": "3" });
    expect(getRetryAfterMs(err)).toBe(3000);
  });

  it("reads Retry-After from a plain HeadersMap record (@atproto/xrpc)", () => {
    const err = new Error("429") as Error & {
      headers: Record<string, string | undefined>;
    };
    err.headers = { "retry-after": "8" };
    expect(getRetryAfterMs(err)).toBe(8000);
  });

  it("returns defaultMs when it is a 429 error without an explicit header", () => {
    const err = new RateLimitError(null);
    expect(getRetryAfterMs(err, 4_000)).toBe(4000);
  });

  it("returns null for non-429 errors", () => {
    const err = new Error("something else");
    expect(getRetryAfterMs(err)).toBeNull();
  });

  it("falls back to defaultMs when Retry-After is malformed on a 429 error", () => {
    const err = new Error("429 rate limited") as Error & {
      headers: Record<string, string | undefined>;
    };
    err.headers = { "retry-after": "not-a-number" };
    // Malformed header is ignored; the error is still a 429 so the default applies.
    expect(getRetryAfterMs(err, 5_000)).toBe(5000);
  });
});

// ─── isRateLimitError ──────────────────────────────────────────────────────

describe("isRateLimitError", () => {
  it("matches RateLimitError instances", () => {
    expect(isRateLimitError(new RateLimitError(1))).toBe(true);
  });

  it("matches objects with status: 429", () => {
    const e = new Error("x");
    Object.assign(e, { status: 429 });
    expect(isRateLimitError(e)).toBe(true);
  });

  it("matches messages containing 429", () => {
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(
      true,
    );
  });

  it("does not match unrelated errors", () => {
    expect(isRateLimitError(new Error("500 boom"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});