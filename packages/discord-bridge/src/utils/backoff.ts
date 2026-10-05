/**
 * Compute an exponential backoff delay for a failed attempt to reach the
 * appserver, shared by the live sync connections and the subscription retry
 * so both back off with one vocabulary.
 *
 * Exponential with full jitter, capped at `max`, floored at 1ms:
 * `max(1, floor(min(base * 2^failures, max) * random()))` (a non-finite draw
 * also floors to 1ms).
 */
export function reconnectDelayMs(
	failures: number,
	base: number,
	max: number,
): number {
	const cap = Math.min(base * 2 ** failures, max);
	// Floor at 1ms. A non-positive return is the SDK's documented "stop
	// reconnecting" signal, not a valid backoff: `SyncConnection` treats
	// `delay <= 0` (or non-finite) in packages/sdk/src/sync/connection.ts as an
	// explicit caller opt-out and logs "Not reconnecting", leaving the socket
	// permanently wedged while every liveness surface still reads healthy.
	// `Math.random()` can return exactly 0, so an unfloored full-jitter draw
	// silently disabled auto-reconnect — the same reason the SDK's own default
	// generator floors its draw.
	const jitter = Math.floor(Math.random() * cap);
	// `Math.max` does not absorb NaN, so a non-finite cap — a base of 0 or
	// NaN (unvalidated env override) with an overflowing 2^failures — would
	// slip a NaN through the floor and trip the SDK's `!Number.isFinite(delay)`
	// branch to that very same stop signal. Floor non-finite draws too.
	return Number.isFinite(jitter) ? Math.max(1, jitter) : 1;
}
