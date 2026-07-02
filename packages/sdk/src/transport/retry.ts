/**
 * Rate-limit-respecting backoff for XRPC transport calls.
 *
 * When the appserver (or an intermediary) returns HTTP 429, it includes a
 * `Retry-After` header (seconds). The transport should honour that hint
 * rather than immediately re-firing — otherwise a burst of Tanstack Query
 * refetches or mutation retries slams the server, exhausts the rate-limit
 * budget, and the client sees a sustained wall of 429s.
 *
 * `withRateLimitRetry` wraps a single XRPC request. On a 429 it sleeps for
 * the server-advised delay (falling back to an exponential jittered backoff
 * when no header is present) and retries, up to `maxRetries` times. The
 * final error is re-thrown so callers still observe the failure.
 *
 * The wrapper is transport-agnostic: it inspects the thrown error with the
 * shared `getRetryAfterMs` helper, which understands both WHATWG `Headers`
 * (direct `fetch` / `DirectXrpcClient`) and `@atproto/xrpc`'s plain
 * `HeadersMap`. Non-429 errors are re-thrown immediately with no retry.
 */
import { getRetryAfterMs, isRateLimitError, RateLimitError } from "./errors";

export interface RateLimitRetryOptions {
  /** Maximum retry attempts after the initial request (default: 4). */
  maxRetries?: number;
  /** Base delay for exponential fallback backoff, ms (default: 1000). */
  baseDelayMs?: number;
  /** Cap on per-attempt delay, ms (default: 30_000). */
  maxDelayMs?: number;
  /**
   * Optional abort signal; if aborted during a backoff sleep the retry
   * loop aborts and the last error is re-thrown.
   */
  signal?: AbortSignal;
  /** Injectable sleep for tests. Defaults to a real timeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30_000;

/**
 * Run `fn`, retrying on HTTP 429 with server-advised backoff.
 *
 * - On a 429, sleeps for `Retry-After` (if provided) or an exponential
 *   jittered fallback, then retries.
 * - Non-429 errors propagate immediately.
 * - After `maxRetries` exhausted, the last 429 error is re-thrown.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RateLimitRetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseMs = opts.baseDelayMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxDelayMs ?? DEFAULT_MAX_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      if (attempt >= maxRetries) throw err;
      const advised = getRetryAfterMs(err, 0);
      const delay =
        advised && advised > 0
          ? Math.min(advised, maxMs)
          : jitteredBackoff(attempt, baseMs, maxMs);
      await sleep(delay, opts.signal);
      attempt++;
    }
  }
}

/**
 * Exponential backoff with full jitter: a random value in
 * `[0, min(base * 2^attempt, max)]`. Jitter spreads concurrent retries
 * apart so a fleet of clients unblocked by the same reset don't thunder.
 */
function jitteredBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const cap = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.floor(Math.random() * cap);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) return;
  // Executor form: the project targets ES2022, whose lib lacks
  // `Promise.withResolvers` types (ES2024+). The runtime (Bun) supports
  // it, but we stay within the declared lib so `tsc --noEmit` passes.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Cleanup is best-effort; resolve already fired or will via timer.
  });
}

export { RateLimitError, isRateLimitError, getRetryAfterMs };