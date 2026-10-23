/**
 * Delivery-retry policy for a push subscription.
 *
 * A transport classifies its own failures (`PushOutcome` in
 * `transports/types.ts`): `gone` means the destination no longer exists,
 * `retry` means the attempt failed in a way that may succeed later — a 429, a
 * 5xx, a dropped connection. Only the second is worth another attempt, and
 * this module says when that attempt is due and when the device is written
 * off.
 *
 * The schedule escalates, because the failure modes differ in how long they
 * last. A dropped connection is usually one attempt's worth of bad luck, so
 * the first re-attempt is 30s away; a push service having an outage can last
 * hours, and re-attempting every device every 30s through it would turn one
 * upstream fault into a flood of our own — and, worse, exhaust every device's
 * attempts and prune them all. Escalation makes the ceiling below mean "this
 * one device has been unreachable for ~9 hours", not "we were unlucky during
 * an outage".
 *
 * A subscription that reaches the ceiling is pruned, exactly like a `gone`
 * row: a destination that has failed this many consecutive attempts is not
 * coming back, and leaving it in place means every later push pays for it
 * forever.
 */

/**
 * Backoff (ms) before re-attempt number `attempts` (1 = after the first
 * failure). Escalating, then capped. Tunable via `PUSH_RETRY_CAP_MS`.
 */
export function retryBackoffMs(attempts: number): number {
  const schedule = [30_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
  const cap = Number(process.env.PUSH_RETRY_CAP_MS ?? 6 * 60 * 60_000);
  return attempts <= schedule.length ? schedule[attempts - 1]! : cap;
}

/** Consecutive transient failures after which a subscription is pruned. */
const MAX_RETRY_ATTEMPTS_DEFAULT = 6;

/**
 * Consecutive transient failures a subscription is allowed before it is
 * pruned.
 *
 * The value follows the schedule's own shape: with {@link retryBackoffMs} a
 * row is re-attempted at 30s, 5m, 30m, 2h and 6h before its sixth consecutive
 * failure — roughly nine hours of continuously failing. A device that has not
 * accepted a push in that window is not temporarily unreachable, while a push
 * service outage is covered by the earlier re-attempts instead of being paid
 * for by a mass prune. Tunable via `PUSH_RETRY_MAX_ATTEMPTS` (minimum 1).
 */
export function maxRetryAttempts(): number {
  const n = Number(process.env.PUSH_RETRY_MAX_ATTEMPTS ?? MAX_RETRY_ATTEMPTS_DEFAULT);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_RETRY_ATTEMPTS_DEFAULT;
}
