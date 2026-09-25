/**
 * Unit tests for LiveDiscordDataSource.getPublicArchivedThreads.
 *
 * Covers the behaviors the archived-thread backfill depends on:
 *   1. The snowflake cursor must survive discordeno's `before` encoding.
 *      @discordeno/rest routes.cjs builds the URL as
 *      `before=${new Date(before).toISOString()}`, so the value we pass
 *      must be a valid epoch-ms Date: `Number(snowflake)` (~7.2e17) is
 *      outside Date's ±8.64e15 ms range and would make `.toISOString()`
 *      throw `RangeError: Invalid Date` on the second page of every
 *      archived-thread backfill.
 *   2. A transient REST failure is retried with backoff, so one bad page
 *      costs retry latency, not the parent channel's remaining history.
 *   3. A deterministic 4xx client error (403 Missing Access on a mapped
 *      parent channel the bot cannot read, 404 after deletion) fails fast —
 *      retrying it cannot change the outcome, and the discordeno wrapper
 *      (which hides the real status in `error.cause`) is surfaced.
 */

import { describe, expect, test } from "bun:test";
import { LiveDiscordDataSource } from "../live-data-source.ts";
import type { DiscordBot } from "../types.ts";

const CHANNEL = "1475625518132105319";
// Real-world archived-thread snowflake cursor (18-digit Discord ID).
const SNOWFLAKE = "720751906225586180";
const DISCORD_EPOCH_MS = 1420070400000;

/** Epoch ms encoded in a snowflake (upper 22 bits) — the cursor's own time. */
function snowflakeEpochMs(snowflake: string): number {
	return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
}

/**
 * Build an error shaped like discordeno's REST wrapper: fixed message,
 * actual response result (status + body) attached as `cause`.
 */
function discordError(status: number, body: string): Error {
	const err = new Error("Failed to send request to discord.");
	Object.assign(err, { cause: { ok: false, status, body } });
	return err;
}

interface FakeBot {
	helpers: {
		getPublicArchivedThreads: (
			channelId: bigint,
			options?: { limit?: number; before?: number },
		) => Promise<{
			threads: Array<{ id: string; type: number; name: string }>;
			members: unknown[];
			hasMore: boolean;
		}>;
	};
}

/**
 * Scripted data source. `failFirst` failures are thrown before the first
 * success; `errorFor(attempt)` lets a test script the failure shape (e.g. a
 * discordeno wrapper carrying a 403 cause) instead of a bare Error.
 */
function makeDataSource(
	failFirst: number,
	errorFor?: (attempt: number) => Error,
): {
	ds: LiveDiscordDataSource;
	calls: Array<{ before: number | undefined; limit: number | undefined }>;
} {
	const calls: Array<{ before: number | undefined; limit: number | undefined }> =
		[];
	let remainingFailures = failFirst;
	const bot: FakeBot = {
		helpers: {
			getPublicArchivedThreads: async (_channelId, options) => {
				calls.push({ before: options?.before, limit: options?.limit });
				if (remainingFailures > 0) {
					remainingFailures--;
					throw errorFor
						? errorFor(calls.length)
						: new Error("simulated REST failure");
				}
				return {
					threads: [{ id: SNOWFLAKE, type: 11, name: "archived" }],
					members: [],
					hasMore: false,
				};
			},
		},
	};
	return {
		ds: new LiveDiscordDataSource(bot as unknown as DiscordBot),
		calls,
	};
}

describe("LiveDiscordDataSource.getPublicArchivedThreads", () => {
	test("passes a snowflake cursor as epoch-ms that survives discordeno's ISO encoding", async () => {
		const { ds, calls } = makeDataSource(0);

		const page = await ds.getPublicArchivedThreads(CHANNEL, {
			before: SNOWFLAKE,
			limit: 100,
		});

		const call = calls[0];
		expect(call).toBeDefined();
		const before = call?.before;
		expect(before).toBeDefined();

		// Replicate discordeno's route encoding: `new Date(before).toISOString()`.
		// Number(snowflake) here would be an Invalid Date.
		if (before === undefined) throw new Error("before was not passed");
		const encoded = new Date(before).toISOString();

		// The cursor must be the snowflake's own creation time, losslessly.
		expect(before).toBe(snowflakeEpochMs(SNOWFLAKE));
		expect(encoded).toBe(new Date(snowflakeEpochMs(SNOWFLAKE)).toISOString());

		// Page passes through normalized.
		expect(page.hasMore).toBe(false);
		expect(page.threads[0]?.id).toBe(SNOWFLAKE);
	});

	test("omits before when no cursor is given", async () => {
		const { ds, calls } = makeDataSource(0);

		await ds.getPublicArchivedThreads(CHANNEL, { limit: 100 });

		expect(calls[0]?.before).toBeUndefined();
		expect(calls[0]?.limit).toBe(100);
	});

	test("retries a transient page failure with backoff before succeeding", async () => {
		const { ds, calls } = makeDataSource(2); // 2 failed attempts, then success

		const page = await ds.getPublicArchivedThreads(CHANNEL, { limit: 100 });

		expect(calls).toHaveLength(3); // budget: 3 attempts total
		expect(page.threads).toHaveLength(1);
	});

	test("throws after the retry budget is exhausted", async () => {
		const { ds, calls } = makeDataSource(10); // always failing

		await expect(
			ds.getPublicArchivedThreads(CHANNEL, { limit: 100 }),
		).rejects.toThrow("simulated REST failure");
		expect(calls).toHaveLength(3); // bounded — no unbounded retry loop
	});

	/**
	 * A first-page failure with no cursor on a channel the bot cannot read.
	 * Discord answers `403 Missing Access` (code 50001); discordeno wraps it
	 * in "Failed to send request to discord." with the status only in `cause`.
	 * Backoff cannot fix a permission denial, so this must fail after ONE
	 * attempt rather than burn the whole 3-attempt budget.
	 */
	test("fails fast on a deterministic 4xx — 403 Missing Access, no retry", async () => {
		const { ds, calls } = makeDataSource(10, () =>
			discordError(403, '{"message": "Missing Access", "code": 50001}'),
		);

		await expect(
			ds.getPublicArchivedThreads(CHANNEL, { limit: 100 }),
		).rejects.toThrow("Failed to send request to discord.");
		expect(calls).toHaveLength(1); // deterministic — exactly one attempt
	});

	test("fails fast on a deterministic 4xx — 404 Unknown Channel, no retry", async () => {
		const { ds, calls } = makeDataSource(10, () =>
			discordError(404, '{"message": "Unknown Channel", "code": 10003}'),
		);

		await expect(
			ds.getPublicArchivedThreads(CHANNEL, { limit: 100 }),
		).rejects.toThrow("Failed to send request to discord.");
		expect(calls).toHaveLength(1);
	});

	test("retries a rate-limited (429) page, then succeeds", async () => {
		const { ds, calls } = makeDataSource(2, () =>
			discordError(429, "rate limited"),
		);

		const page = await ds.getPublicArchivedThreads(CHANNEL, { limit: 100 });

		expect(calls).toHaveLength(3); // 2 rate-limits + success
		expect(page.threads).toHaveLength(1);
	});

	test("retries a 5xx server error, then succeeds", async () => {
		const { ds, calls } = makeDataSource(2, () =>
			discordError(500, "internal server error"),
		);

		const page = await ds.getPublicArchivedThreads(CHANNEL, { limit: 100 });

		expect(calls).toHaveLength(3);
		expect(page.threads).toHaveLength(1);
	});
});
