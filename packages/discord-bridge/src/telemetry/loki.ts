/**
 * In-app Loki sink: batches structured log records and POSTs them to a
 * Grafana Alloy Loki push API endpoint (deploy/alloy/config.alloy).
 *
 * Design constraints:
 * - Bounded queue (drop-oldest) so a dead Alloy can't grow memory unbounded.
 * - Batch flush on interval + size to amortise HTTP round-trips.
 * - NEVER throws or blocks the app: fire-and-forget, all errors caught,
 *   failed batches re-queued at the front and retried with exponential
 *   backoff; the bounded queue drops oldest entries under sustained failure.
 * - Disabled when `ALLOY_URL` is unset (dev default: stdout only).
 */

export interface LokiRecord {
	/** Pre-serialized JSON log line (the value Loki stores). */
	line: string;
	/** Stream labels (service_name, level, scope, ...). */
	labels: Record<string, string>;
	/** Log timestamp in ms since epoch (Loki value timestamp). */
	ts: number;
}

export interface LokiSink {
	push(record: LokiRecord): void;
	/** Flush queued records (awaits in-flight flush). Tests + shutdown. */
	flush(): Promise<void>;
	/** Stop the flush timer; best-effort final flush. */
	stop(): void;
	stats(): { queued: number; sent: number; dropped: number; failed: number };
}

export interface LokiSinkOptions {
	maxQueue?: number;
	batchSize?: number;
	flushIntervalMs?: number;
	initialBackoffMs?: number;
	maxBackoffMs?: number;
	pushTimeoutMs?: number;
}

const DEFAULTS = {
	maxQueue: 10_000,
	batchSize: 500,
	flushIntervalMs: 2_000,
	initialBackoffMs: 1_000,
	maxBackoffMs: 60_000,
	pushTimeoutMs: 5_000,
} as const;

export function createLokiSink(
	url?: string | null,
	options?: LokiSinkOptions,
): LokiSink | null {
	const pushUrl: string = (url === undefined ? process.env.ALLOY_URL : url) ?? "";
	if (pushUrl === "") return null;

	const maxQueue = options?.maxQueue ?? DEFAULTS.maxQueue;
	const batchSize = options?.batchSize ?? DEFAULTS.batchSize;
	const flushIntervalMs = options?.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
	const initialBackoffMs = options?.initialBackoffMs ?? DEFAULTS.initialBackoffMs;
	const maxBackoffMs = options?.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
	const pushTimeoutMs = options?.pushTimeoutMs ?? DEFAULTS.pushTimeoutMs;

	let queue: LokiRecord[] = [];
	let sent = 0;
	let dropped = 0;
	let failed = 0;
	let backoffMs = initialBackoffMs;
	let backoffUntil = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	let flushChain: Promise<void> = Promise.resolve();

	async function postBatch(batch: LokiRecord[]): Promise<void> {
		const streams = new Map<
			string,
			{ stream: Record<string, string>; values: [string, string][] }
		>();
		for (const rec of batch) {
			const key = JSON.stringify(rec.labels);
			let entry = streams.get(key);
			if (!entry) {
				entry = { stream: rec.labels, values: [] };
				streams.set(key, entry);
			}
			entry.values.push([String(rec.ts * 1_000_000), rec.line]);
		}
		const res = await fetch(pushUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ streams: [...streams.values()] }),
			signal: AbortSignal.timeout(pushTimeoutMs),
		});
		if (!res.ok) throw new Error(`loki push failed: HTTP ${res.status}`);
	}

	function flushNow(): Promise<void> {
		flushChain = flushChain.then(async () => {
			if (queue.length === 0) return;
			if (Date.now() < backoffUntil) return;
			const batch = queue.splice(0, batchSize);
			try {
				await postBatch(batch);
				sent += batch.length;
				backoffMs = initialBackoffMs;
			} catch {
				failed++;
				queue.unshift(...batch);
				if (queue.length > maxQueue) {
					dropped += queue.length - maxQueue;
					queue.length = maxQueue;
				}
				backoffUntil = Date.now() + backoffMs;
				backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
			}
		});
		return flushChain;
	}

	timer = setInterval(() => {
		void flushNow();
	}, flushIntervalMs);
	timer.unref();

	return {
		push(record: LokiRecord): void {
			if (queue.length >= maxQueue) {
				queue.shift();
				dropped++;
			}
			queue.push(record);
			if (queue.length >= batchSize) void flushNow();
		},
		flush(): Promise<void> {
			return flushNow();
		},
		stop(): void {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
			void flushNow();
		},
		stats(): { queued: number; sent: number; dropped: number; failed: number } {
			return { queued: queue.length, sent, dropped, failed };
		},
	};
}
