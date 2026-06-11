/**
 * LiveDiscordDataSource: wraps a DiscordBot (Discordeno) and converts
 * Discordeno types to plain data types via normalizers.
 *
 * This is a **thin REST pass-through** — no caching. Every call hits
 * the Discord REST API. If caching is needed, it belongs in a wrapper
 * layer above this, so the caching logic can be tested independently.
 */

import type {
	DiscordBot,
	ChannelProperties,
	MessageProperties,
} from "./types.ts";
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
import { normalizeMessage, normalizeChannel } from "./normalizers.ts";

export class LiveDiscordDataSource implements DiscordDataSource {
	#bot: DiscordBot;

	constructor(bot: DiscordBot) {
		this.#bot = bot;
	}

	async getMessages(
		channelId: string,
		opts: PaginationOpts,
	): Promise<DiscordMessageData[]> {
		const raw = await this.#bot.helpers.getMessages(BigInt(channelId), {
			after: opts.after ? BigInt(opts.after) : undefined,
			before: opts.before ? BigInt(opts.before) : undefined,
			limit: opts.limit ?? 100,
		});
		return raw.map(normalizeMessage);
	}

	async getChannel(channelId: string): Promise<DiscordChannelData | undefined> {
		try {
			const raw = await this.#bot.helpers.getChannel(BigInt(channelId));
			return normalizeChannel(raw);
		} catch {
			return undefined;
		}
	}

	async getChannels(guildId: string): Promise<DiscordChannelData[]> {
		try {
			const raw = await this.#bot.helpers.getChannels(BigInt(guildId));
			return raw.map((ch) => normalizeChannel(ch));
		} catch {
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
		} catch {
			return undefined;
		}
	}

	async getPublicArchivedThreads(
		channelId: string,
		opts: PaginationOpts,
	): Promise<ThreadPage> {
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
}
