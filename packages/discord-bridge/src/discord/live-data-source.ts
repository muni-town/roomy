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
import type { DiscordBot } from "./types.ts";

const log = createLogger("live-discord");

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
		try {
			// Discordeno types ListArchivedThreads.before as number (timestamp), but
			// the Discord API accepts a snowflake or ISO8601 timestamp. Pass our
			// snowflake as-is — the API handles both.
			const params: { limit: number; before?: number } = {
				limit: opts.limit ?? 100,
			};
			if (opts.before) {
				// Discordeno's type says `before: number`, but the API accept/s snowflake strings
				params.before = Number(opts.before);
			}
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
			log.error(
				`getPublicArchivedThreads failed for channel ${channelId} (before=${opts.before ?? "-"}, limit=${opts.limit ?? 100})`,
				err,
			);
			throw err;
		}
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
			const result = await this.#bot.helpers.getActiveThreads(
				BigInt(guildId),
			);
			return result.threads.map((t) => normalizeChannel(t));
		} catch (err) {
			log.warn(`getActiveThreads failed for guild ${guildId}`, err);
			return [];
		}
	}
}
