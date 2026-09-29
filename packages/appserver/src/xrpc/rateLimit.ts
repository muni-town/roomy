/**
 * Rate limiting for the XRPC router using `rate-limiter-flexible`.
 *
 * Single in-memory rate limiter for all XRPC requests. Keys are derived from
 * the client's IP — either the direct connection IP (default) or the
 * `X-Forwarded-For` header when `RATE_LIMIT_TRUST_PROXY=true`. Auth is not
 * consulted — rate limiting is purely IP-based so it can run before
 * authentication.
 *
 * All limits are configurable via environment variables:
 *
 * | Variable                    | Default | Description                                |
 * |-----------------------------|---------|--------------------------------------------|
 * | `RATE_LIMIT_POINTS`         | 100     | Max requests per window                    |
 * | `RATE_LIMIT_DURATION`       | 60      | Window in seconds                          |
 * | `RATE_LIMIT_BLOCK_DURATION` | 120     | Seconds to block when limit exceeded       |
 * | `RATE_LIMIT_TRUST_PROXY`    | false   | Use X-Forwarded-For instead of direct IP   |
 * | `RATE_LIMIT_DISABLED`       | false   | Set to "true" to disable all limiting      |
 */

import { RateLimiterMemory } from "rate-limiter-flexible";

// ─── Env helpers ────────────────────────────────────────────────────────

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

function envBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return def;
  return raw === "true" || raw === "1";
}

// ─── Configuration ──────────────────────────────────────────────────────

const DISABLED = envBool("RATE_LIMIT_DISABLED", false);
const TRUST_PROXY = envBool("RATE_LIMIT_TRUST_PROXY", false);

const POINTS = envInt("RATE_LIMIT_POINTS", 100);
const DURATION = envInt("RATE_LIMIT_DURATION", 60);
const BLOCK_DURATION = envInt("RATE_LIMIT_BLOCK_DURATION", 120);

// ─── Limiter ────────────────────────────────────────────────────────────

// TODO: The module-level limiter is shared across all test files and uses
// real time windows. Tests that run concurrently and hit the same IP can
// exhaust each other's points and flake. `_resetRateLimit()` recreates the
// limiter between tests; consider RATE_LIMIT_DISABLED=true in a global setup.
let limiter = new RateLimiterMemory({
  keyPrefix: "rl",
  points: POINTS,
  duration: DURATION,
  blockDuration: BLOCK_DURATION,
});

/**
 * Reset the in-memory limiter between tests. Tests-only hook: because the
 * limiter is a module-level singleton shared across all test files (which run
 * in one process), accumulated points and blocks can leak between files and
 * 429 later tests. Recreating it gives each test a clean slate.
 */
export function _resetRateLimit(): void {
  limiter = new RateLimiterMemory({
    keyPrefix: "rl",
    points: POINTS,
    duration: DURATION,
    blockDuration: BLOCK_DURATION,
  });
  endpointLimiters = buildEndpointLimiters();
}

// ─── Key extraction ─────────────────────────────────────────────────────

/**
 * Derive a rate-limit key for the request.
 *
 * When `RATE_LIMIT_TRUST_PROXY=true`, uses the first IP from the
 * `X-Forwarded-For` header. Otherwise uses the direct connection IP
 * provided by the Bun server. Falls back to a sentinel if neither is
 * available.
 *
 * @param req - The incoming HTTP request.
 * @param directIp - The peer IP from `server.requestIP(req)`, if available.
 */
function clientKey(req: Request, directIp: string): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const ip = forwarded.split(",")[0]?.trim();
      if (ip) return ip;
    }
  }

  return directIp;
}

// ─── Rate limit result ──────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the client can retry (0 if allowed). */
  retryAfterMs: number;
  /** Remaining points in the current window. */
  remaining: number;
}

// ─── Check function ─────────────────────────────────────────────────────

/**
 * Check the rate limit for a request.
 *
 * @param req - The incoming HTTP request.
 * @param directIp - The peer IP from `server.requestIP(req)`, or null if
 *   unavailable. Ignored when `RATE_LIMIT_TRUST_PROXY=true`.
 */
export async function checkRateLimit(
  req: Request,
  directIp: string,
): Promise<RateLimitResult> {
  if (DISABLED) {
    return { allowed: true, retryAfterMs: 0, remaining: Infinity };
  }

  try {
    const res = await limiter.consume(clientKey(req, directIp), 1);
    return {
      allowed: true,
      retryAfterMs: res.msBeforeNext,
      remaining: res.remainingPoints,
    };
  } catch (rej: unknown) {
    const res = rej as { msBeforeNext?: number; remainingPoints?: number };
    return {
      allowed: false,
      retryAfterMs: res.msBeforeNext ?? BLOCK_DURATION * 1000,
      remaining: res.remainingPoints ?? 0,
    };
  }
}

// ─── Rate limit response builder ────────────────────────────────────────

export function rateLimitResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    {
      error: "RateLimitExceeded",
      message: `Too many requests. Retry after ${retryAfterSec} second(s).`,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSec),
        "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + retryAfterSec),
      },
    },
  );
}

// ─── Per-endpoint limits ────────────────────────────────────────────────

/**
 * Limits for endpoints that cost more than a normal request — currently only
 * the unauthenticated handle→DID resolution query
 * (`space.roomy.auth.getLoginScope`). It is reachable without a token, so the
 * global IP limiter (100/60s) is too loose: every call fans out to DNS + HTTP
 * resolution against an attacker-chosen domain, which is a
 * resolution-amplification vector. 10/min/IP still comfortably covers a
 * legitimate client (one call per login attempt, plus retries behind a shared
 * NAT), while capping the amplification at 10 lookups/min/IP.
 *
 * `RATE_LIMIT_DISABLED=true` disables these too, matching the global limiter.
 */
interface EndpointLimit {
  points: number;
  durationSec: number;
}

export const ENDPOINT_RATE_LIMITS: Readonly<Record<string, EndpointLimit>> = {
  "space.roomy.auth.getLoginScope": {
    points: envInt("RATE_LIMIT_GETLOGINSCOPE_POINTS", 10),
    durationSec: envInt("RATE_LIMIT_GETLOGINSCOPE_DURATION", 60),
  },
};

let endpointLimiters = buildEndpointLimiters();

function buildEndpointLimiters(): Record<string, RateLimiterMemory> {
  const limiters: Record<string, RateLimiterMemory> = {};
  for (const [nsid, limit] of Object.entries(ENDPOINT_RATE_LIMITS)) {
    limiters[nsid] = new RateLimiterMemory({
      keyPrefix: `rl:${nsid}`,
      points: limit.points,
      duration: limit.durationSec,
      blockDuration: BLOCK_DURATION,
    });
  }
  return limiters;
}

/**
 * Check the per-endpoint limit for `nsid`. Returns an allow result for any
 * NSID without a configured limit, so callers can invoke this unconditionally.
 */
export async function checkEndpointRateLimit(
  nsid: string,
  req: Request,
  directIp: string,
): Promise<RateLimitResult> {
  const endpointLimiter = endpointLimiters[nsid];
  if (DISABLED || !endpointLimiter) {
    return { allowed: true, retryAfterMs: 0, remaining: Infinity };
  }

  try {
    const res = await endpointLimiter.consume(clientKey(req, directIp), 1);
    return {
      allowed: true,
      retryAfterMs: res.msBeforeNext,
      remaining: res.remainingPoints,
    };
  } catch (rej: unknown) {
    const res = rej as { msBeforeNext?: number; remainingPoints?: number };
    return {
      allowed: false,
      retryAfterMs: res.msBeforeNext ?? BLOCK_DURATION * 1000,
      remaining: res.remainingPoints ?? 0,
    };
  }
}
