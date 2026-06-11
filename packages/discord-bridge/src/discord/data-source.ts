/**
 * DiscordDataSource: abstraction over Discord data reads.
 *
 * Decouples service logic from the live Discord bot connection,
 * enabling testing against file exports or generated fake data.
 */

import type {
	DiscordMessageData,
	DiscordChannelData,
	DiscordGuildData,
} from "./data.ts";

export interface PaginationOpts {
	after?: string;
	before?: string;
	limit?: number;
}

export interface ThreadPage {
	threads: DiscordChannelData[];
	hasMore: boolean;
}

/**
 * Interface for reading Discord data.
 *
 * All methods return plain data types (DiscordMessageData etc.) rather than
 * Discordeno's full type system, keeping service logic dependency-free.
 */
export interface DiscordDataSource {
	/** Fetch messages from a channel, newest-first. */
	getMessages(
		channelId: string,
		opts: PaginationOpts,
	): Promise<DiscordMessageData[]>;

	/** Get a single channel by ID. */
	getChannel(channelId: string): Promise<DiscordChannelData | undefined>;

	/** Get all top-level channels for a guild. */
	getChannels(guildId: string): Promise<DiscordChannelData[]>;

	/** Get a guild by ID. */
	getGuild(guildId: string): Promise<DiscordGuildData | undefined>;

	/** Fetch public archived threads for a channel. */
	getPublicArchivedThreads(
		channelId: string,
		opts: PaginationOpts,
	): Promise<ThreadPage>;

	/** Resolve a channel's name (may require REST fallback). */
	resolveChannelName(channelId: string): Promise<string | undefined>;

	/** Resolve a channel's type (may require REST fallback). */
	resolveChannelType(channelId: string): Promise<number | undefined>;

	/** Resolve the guild ID that a channel belongs to. */
	resolveGuildIdForChannel(channelId: string): Promise<string | undefined>;
}
