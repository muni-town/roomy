/**
 * LiveDiscordDataSource: wraps a DiscordBot (Discordeno) and converts
 * Discordeno types to plain data types via normalizers.
 *
 * This is a **thin REST pass-through** — no caching. Every call hits
 * the Discord REST API. If caching is needed, it belongs in a wrapper
 * layer above this, so the caching logic can be tested independently.
 */

import { createLogger } from "../logger.ts";
import type {
	DiscordChannelData,
	DiscordGuildData,
	DiscordMessageData,
} from "./data.ts";
import type {
	DiscordDataSource,
	PaginationOpts,
	ThreadPage,
} from "./data-source.ts";
import { normalizeChannel, normalizeMessage } from "./normalizers.ts";
import { discordFailureDetail } from "./rest-errors.ts";
import type { DiscordBot } from "./types.ts";

const log = createLogger("live-discord");

const DISCORD_EPOCH_MS = 1420070400000; // Discord epoch: 2015-01-01T00:00:00Z

/**
 * Millisecond timestamp encoded in a Discord snowflake (its upper 22 bits).
 *
 * Discord's list-archived-threads `before` accepts a snowflake or an ISO8601
 * timestamp, but discordeno rewrites the option into a URL query parameter via
 * `new Date(before).toISOString()` (see routes.cjs in @discordeno/rest). A
 * raw snowflake is an 18–19 digit decimal — `Number(snowflake)` rounds it to
 * ~7.2e17, which is outside `Date`'s valid range (±8.64e15 ms), so
 * `.toISOString()` throws `RangeError: Invalid Date`. Decode the snowflake's
 * encoded epoch instead: it stays well inside `Date`'s range and round-trips
 * exactly through discordeno's conversion, which matches Discord's own
 * snowflake→timestamp treatment of the parameter.
 */
function snowflakeToEpochMs(snowflake: string): number {
	// The timestamp occupies the upper 22 bits; the remainder is at most
	// 2^41, which Number represents exactly.
	return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Bounded retry for one archived-thread page fetch. Backfill paginates
 * through the whole guild, so a single transient REST failure must cost
 * retry latency — not the parent channel's remaining history.
 *
 * Retries apply ONLY to statuses that can plausibly succeed on a second try:
 * rate-limited (429), server-side (5xx), and network-level (999 / unknown).
 * Deterministic 4xx client errors (403 Missing Access on a mapped parent
 * channel the bot cannot read, 400 on a non-thread-capable channel type, 404
 * after the channel was deleted) are rejected before Discord executes the
 * request — backoff cannot change the outcome, so failing fast (and letting
 * the backfill loop isolate the parent channel) is strictly better than
 * burning the whole retry budget on a known-constant answer.
 */
const THREAD_PAGE_RETRY_ATTEMPTS = 3;
const THREAD_PAGE_RETRY_BASE_DELAY_MS = 500;

/** Max chars of a Discord error body to inline into a log line. */
const MAX_BODY_CHARS = 200;

/** True when retrying can plausibly succeed (transient status or unknown). */
function isRetryableDiscordStatus(status: number | undefined): boolean {
	if (status === undefined) return true;
	return status === 429 || status === 999 || status >= 500;
}

export class LiveDiscordDataSource implements DiscordDataSource {
	#bot: DiscordBot;

	constructor(bot: DiscordBot) {
		this.#bot = bot;
	}

	async getMessages(
		channelId: string,
		opts: PaginationOpts,
	): Promise<DiscordMessageData[]> {
		try {
			const raw = await this.#bot.helpers.getMessages(BigInt(channelId), {
				after: opts.after ? BigInt(opts.after) : undefined,
				before: opts.before ? BigInt(opts.before) : undefined,
				limit: opts.limit ?? 100,
			});
			return raw.map(normalizeMessage);
		} catch (err) {
			log.error(
				`getMessages failed for channel ${channelId} (after=${opts.after ?? "-"}, before=${opts.before ?? "-"}, limit=${opts.limit ?? 100})`,
				err,
			);
			throw err;
		}
	}

	async getChannel(channelId: string): Promise<DiscordChannelData | undefined> {
		try {
			const raw = await this.#bot.helpers.getChannel(BigInt(channelId));
			return normalizeChannel(raw);
		} catch (err) {
			log.warn(`getChannel failed for channel ${channelId}`, err);
			return undefined;
		}
	}

	async getChannels(guildId: string): Promise<DiscordChannelData[]> {
		try {
			const raw = await this.#bot.helpers.getChannels(BigInt(guildId));
			return raw.map((ch) => normalizeChannel(ch));
		} catch (err) {
			log.warn(`getChannels failed for guild ${guildId}`, err);
			return [];
		}
	}

	async getGuild(guildId: string): Promise<DiscordGuildData | undefined> {
		try {
			const guild = await this.#bot.helpers.getGuild(BigInt(guildId));
			const channels = await this.getChannels(guildId);
			return {
				id: guild.id.toString(),
				channels,
			};
		} catch (err) {
			log.warn(`getGuild failed for guild ${guildId}`, err);
			return undefined;
		}
	}

	async getPublicArchivedThreads(
		channelId: string,
		opts: PaginationOpts,
	): Promise<ThreadPage> {
		const params: { limit: number; before?: number } = {
			limit: opts.limit ?? 100,
		};
		if (opts.before) {
			// discordeno types `before` as number and URL-encodes it as
			// `new Date(before).toISOString()`. Pass the epoch ms our snowflake
			// cursor encodes — a bare `Number(snowflake)` overflows Date's range.
			params.before = snowflakeToEpochMs(opts.before);
		}

		// Backfill paginates through this loop for a whole guild, so a single
		// transient REST failure must not abort the parent channel's history:
		// retry with a bounded backoff, and only log/throw once exhausted.
		// Deterministic 4xx client errors (e.g. 403 Missing Access on a mapped
		// parent the bot cannot read, 404 after channel deletion) are NOT
		// retried — they cannot succeed, and failing fast keeps the per-parent
		// cost to one attempt while the real status/body is put in the log.
		let lastError: unknown;
		for (let attempt = 1; attempt <= THREAD_PAGE_RETRY_ATTEMPTS; attempt++) {
			try {
				const result = await this.#bot.helpers.getPublicArchivedThreads(
					BigInt(channelId),
					params,
				);

				const threads: DiscordChannelData[] = result.threads.map((t) =>
					normalizeChannel(t),
				);

				return {
					threads,
					hasMore: result.hasMore,
				};
			} catch (err) {
				lastError = err;
				const { status, body } = discordFailureDetail(err);
				const detail =
					status === undefined
						? "(no HTTP status)"
						: `(discord status ${status}${
								body
									? `: ${
											body.length <= MAX_BODY_CHARS
												? body
												: `${body.slice(0, MAX_BODY_CHARS)}…`
										}`
									: ""
							})`;
				const context = `getPublicArchivedThreads failed for channel ${channelId} (before=${opts.before ?? "-"}, limit=${opts.limit ?? 100}) ${detail}`;

				// Non-retryable: the request was rejected before execution. One
				// clear attempt, one clear error line — backoff can't help.
				if (!isRetryableDiscordStatus(status)) {
					log.error(
						`${context}, attempt ${attempt}; not retrying (non-retryable)`,
						err,
					);
					throw err;
				}

				if (attempt < THREAD_PAGE_RETRY_ATTEMPTS) {
					log.warn(
						`${context}, attempt ${attempt}/${THREAD_PAGE_RETRY_ATTEMPTS}; retrying`,
						err,
					);
					await sleep(
						THREAD_PAGE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
					);
				}
			}
		}
		log.error(
			`getPublicArchivedThreads failed for channel ${channelId} (before=${opts.before ?? "-"}, limit=${opts.limit ?? 100}) after ${THREAD_PAGE_RETRY_ATTEMPTS} attempts`,
			lastError,
		);
		throw lastError;
	}

	async resolveChannelName(channelId: string): Promise<string | undefined> {
		const ch = await this.getChannel(channelId);
		return ch?.name;
	}

	async resolveChannelType(channelId: string): Promise<number | undefined> {
		const ch = await this.getChannel(channelId);
		return ch?.type;
	}

	async resolveGuildIdForChannel(
		channelId: string,
	): Promise<string | undefined> {
		const ch = await this.getChannel(channelId);
		return ch?.guildId;
	}

	async getActiveThreads(guildId: string): Promise<DiscordChannelData[]> {
		try {
			const result = await this.#bot.helpers.getActiveThreads(BigInt(guildId));
			return result.threads.map((t) => normalizeChannel(t));
		} catch (err) {
			log.warn(`getActiveThreads failed for guild ${guildId}`, err);
			return [];
		}
	}
}
