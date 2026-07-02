/**
 * Typed error raised when an XRPC response (or request input) fails to parse
 * against its arktype schema. Carries the NSID and the underlying arktype
 * error so callers can surface contract drift between client and appserver.
 */
import type { type } from "arktype";

export class XrpcResponseValidationError extends Error {
  readonly nsid: string;
  readonly arktypeError: type.errors;

  constructor(nsid: string, arktypeError: type.errors) {
    super(`XRPC response failed validation for ${nsid}: ${arktypeError.summary}`);
    this.name = "XrpcResponseValidationError";
    this.nsid = nsid;
    this.arktypeError = arktypeError;
  }
}

/**
 * Raised when the server returns an HTTP 429 (Too Many Requests) response.
 * Carries the `Retry-After` header value (in seconds) when available.
 */
export class RateLimitError extends Error {
  /** HTTP status code (always 429). */
  readonly status = 429;
  /** Retry-After value in seconds, if the server provided one. */
  readonly retryAfterSec: number | null;

  constructor(retryAfterSec: number | null, message?: string) {
    super(message ?? "Rate limited by server (429)");
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Check if an error is (or wraps) an HTTP 429 / rate-limit response.
 * Walks the error chain and checks `status`, `statusCode`, and message content.
 */
export function isRateLimitError(err: unknown): err is RateLimitError & { status: 429 } {
  if (err instanceof RateLimitError) return true;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (e.status === 429 || e.statusCode === 429) return true;
    // @atproto/xrpc throws objects with a `status` field
    if (typeof e.message === "string" && e.message.includes("429")) return true;
  }
  return false;
}

/**
 * Extract a Retry-After value (ms) from an error, if available.
 * Returns `null` if no Retry-After information is found and the error is
 * not a rate-limit error; returns `defaultMs` when the error *is* a
 * rate-limit error but carries no explicit Retry-After.
 *
 * Handles two header shapes:
 *  - `Headers` (WHATWG) — from `DirectXrpcClient`'s `RateLimitError` and
 *    raw `fetch` responses; accessed via `.get("retry-after")`.
 *  - `Record<string, string|undefined>` (`HeadersMap`) — from
 *    `@atproto/xrpc`'s `XRPCError.headers`; accessed by key lookup.
 */
export function getRetryAfterMs(err: unknown, defaultMs = 5000): number | null {
  if (err instanceof RateLimitError && err.retryAfterSec != null) {
    return err.retryAfterSec * 1000;
  }
  if (err && typeof err === "object") {
    const headers = (err as Record<string, unknown>).headers;
    if (headers && typeof headers === "object") {
      const ra = readRetryAfter(headers);
      if (ra !== null) return ra;
    }
  }
  return isRateLimitError(err) ? defaultMs : null;
}

/**
 * Read a positive Retry-After value (in ms) from a headers object, which
 * may be either a WHATWG `Headers` (has a `.get()` method) or a plain
 * `Record<string, string|undefined>` (the `HeadersMap` used by
 * `@atproto/xrpc`). Returns `null` if absent or unparseable.
 */
function readRetryAfter(headers: object): number | null {
  // WHATWG Headers — duck-typed via the get method.
  if ("get" in headers && typeof headers.get === "function") {
    const ra = headers.get("retry-after");
    return parseRetryAfter(ra);
  }
  // Plain HeadersMap record — narrow with `in` before indexing.
  if ("retry-after" in headers) {
    const ra = headers["retry-after"];
    if (typeof ra === "string") return parseRetryAfter(ra);
  }
  return null;
}

function parseRetryAfter(ra: string | null): number | null {
  if (typeof ra !== "string") return null;
  const sec = Number(ra);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}
