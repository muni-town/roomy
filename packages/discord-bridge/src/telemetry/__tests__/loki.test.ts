/**
 * Unit tests for the Loki pusher: batching, drop-oldest, never-throws on
 * network failure, and retry with backoff. Uses a mock HTTP server
 * (Bun.serve on an ephemeral port) — no real network.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { createLokiSink, type LokiSink, type LokiRecord } from "../loki.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
let received: { stream: Record<string, string>; values: [string, string][] }[] = [];
let statusQueue: number[] = [];
let origAlloyUrl: string | undefined;

function record(
	line: string,
	labels: Record<string, string>,
	ts = 1_700_000_000_000,
): LokiRecord {
	return { line, labels, ts };
}

async function startMockServer(): Promise<string> {
	received = [];
	statusQueue = [];
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as {
				streams: { stream: Record<string, string>; values: [string, string][] }[];
			};
			received.push(...body.streams);
			const status = statusQueue.shift() ?? 200;
			return new Response(status === 200 ? "{}" : "nope", { status });
		},
	});
	return `http://127.0.0.1:${server.port}/loki/api/v1/push`;
}

beforeEach(() => {
	origAlloyUrl = process.env.ALLOY_URL;
	delete process.env.ALLOY_URL;
});

afterEach(() => {
	server?.stop(true);
	server = null;
	if (origAlloyUrl === undefined) delete process.env.ALLOY_URL;
	else process.env.ALLOY_URL = origAlloyUrl;
});

describe("createLokiSink", () => {
	test("returns null when ALLOY_URL is unset", () => {
		expect(createLokiSink()).toBeNull();
	});

	test("returns a sink when ALLOY_URL is set", () => {
		process.env.ALLOY_URL = "http://alloy:3100/loki/api/v1/push";
		const sink = createLokiSink();
		expect(sink).not.toBeNull();
		sink!.stop();
	});
});

describe("batching", () => {
	test("records arrive in one POST grouped by stream labels", async () => {
		const url = await startMockServer();
		const sink = createLokiSink(url, { batchSize: 3, flushIntervalMs: 60_000 })!;

		sink.push(
			record('{"msg":"a"}', { service_name: "discord-bridge", level: "info", scope: "startup" }, 1),
		);
		sink.push(
			record('{"msg":"b"}', { service_name: "discord-bridge", level: "info", scope: "startup" }, 2),
		);
		sink.push(
			record('{"msg":"c"}', { service_name: "discord-bridge", level: "warn", scope: "ingest" }, 3),
		);
		await sink.flush();

		expect(received).toHaveLength(2);
		const startup = received.find((s) => s.stream.scope === "startup")!;
		const ingest = received.find((s) => s.stream.scope === "ingest")!;
		expect(startup.stream).toEqual({
			service_name: "discord-bridge",
			level: "info",
			scope: "startup",
		});
		expect(startup.values).toHaveLength(2);
		expect(startup.values[0]![1]).toBe('{"msg":"a"}');
		expect(startup.values[0]![0]).toBe("1000000"); // ts ms → ns
		expect(ingest.values).toHaveLength(1);
		expect(ingest.values[0]![1]).toBe('{"msg":"c"}');

		const stats = sink.stats();
		expect(stats.sent).toBe(3);
		expect(stats.queued).toBe(0);
		sink.stop();
	});

	test("push flushes automatically once the batch size is reached", async () => {
		const url = await startMockServer();
		const sink = createLokiSink(url, { batchSize: 2, flushIntervalMs: 60_000 })!;

		sink.push(
			record('{"msg":"x"}', { service_name: "discord-bridge", level: "info", scope: "s" }, 1),
		);
		sink.push(
			record('{"msg":"y"}', { service_name: "discord-bridge", level: "info", scope: "s" }, 2),
		);
		await sink.flush();

		expect(received).toHaveLength(1);
		expect(received[0]!.values).toHaveLength(2);
		sink.stop();
	});
});

describe("bounded queue", () => {
	test("drop-oldest when the queue exceeds maxQueue", async () => {
		const url = await startMockServer();
		const sink = createLokiSink(url, {
			maxQueue: 3,
			batchSize: 100,
			flushIntervalMs: 60_000,
		})!;

		for (let i = 0; i < 5; i++) {
			sink.push(
				record(`{"msg":"${i}"}`, { service_name: "discord-bridge", level: "info", scope: "s" }, i),
			);
		}

		const stats = sink.stats();
		expect(stats.queued).toBe(3);
		expect(stats.dropped).toBe(2);

		await sink.flush();
		expect(received[0]!.values.map((v) => v[1])).toEqual([
			'{"msg":"2"}',
			'{"msg":"3"}',
			'{"msg":"4"}',
		]);
		sink.stop();
	});
});

describe("failure handling", () => {
	test("never throws on network failure; records are retained and retried", async () => {
		// The sink's backoff window is checked against Date.now(); drive it
		// deterministically instead of sleeping on real time.
		let now = 1_000_000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const url = await startMockServer();
			statusQueue.push(500, 200);
			const sink = createLokiSink(url, {
				batchSize: 2,
				flushIntervalMs: 60_000,
				initialBackoffMs: 1_000,
				maxBackoffMs: 2_000,
			})!;

			sink.push(
				record('{"msg":"a"}', { service_name: "discord-bridge", level: "info", scope: "s" }, 1),
			);
			sink.push(
				record('{"msg":"b"}', { service_name: "discord-bridge", level: "info", scope: "s" }, 2),
			);
			await sink.flush();

			let stats = sink.stats();
			expect(stats.failed).toBe(1);
			expect(stats.sent).toBe(0);
			expect(stats.queued).toBe(2);

			// Second flush is still inside the backoff window → no attempt.
			await sink.flush();
			stats = sink.stats();
			expect(stats.failed).toBe(1);
			expect(stats.queued).toBe(2);

			// Advance the clock past the backoff; the retry then succeeds.
			now += 1_100;
			await sink.flush();
			stats = sink.stats();
			expect(stats.sent).toBe(2);
			expect(stats.queued).toBe(0);
			expect(stats.failed).toBe(1);
			expect(received[0]!.values).toHaveLength(2);
			sink.stop();
		} finally {
			nowSpy.mockRestore();
		}
	});

	test("push never throws when the endpoint is unreachable", async () => {
		// Port 1 has no listener; connection is refused immediately.
		const sink = createLokiSink("http://127.0.0.1:1/loki/api/v1/push", {
			batchSize: 1,
			flushIntervalMs: 60_000,
			initialBackoffMs: 5,
			maxBackoffMs: 10,
		})!;

		expect(() => {
			for (let i = 0; i < 10; i++) {
				sink.push(
					record(`{"msg":"${i}"}`, { service_name: "discord-bridge", level: "info", scope: "s" }, i),
				);
			}
		}).not.toThrow();

		await sink.flush();
		const stats = sink.stats();
		expect(stats.failed).toBeGreaterThan(0);
		expect(stats.queued).toBeGreaterThan(0);
		sink.stop();
	});
});
