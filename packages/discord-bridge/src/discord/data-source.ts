/**
 * DiscordDataSource: abstraction over Discord data reads.
 *
 * Decouples service logic from the live Discord bot connection,
 * enabling testing against file exports or generated fake data.
 */

import type {
	DiscordChannelData,
	DiscordGuildData,
	DiscordMessageData,
} from "./data.ts";

export interface PaginationOpts {
	after?: string;
	before?: string;
	limit?: number;
}

/**
 * A failed channel read that a later attempt could plausibly satisfy: a
 * rate-limited (429), server-side (5xx), or network-level failure. Its cause
 * carries no durable reason — the failure is not terminal.
 */
export interface ChannelReadFailure {
	reason: null;
	/** The underlying error, for the caller's log line. */
	error: unknown;
}

/**
 * Why a channel read failed, or null when it simply found nothing.
 *
 * A read that fails cannot be told apart from one that finds nothing by its
 * return value alone (both would be `undefined`), and the two demand opposite
 * handling: a failure whose cause is permanent must be recorded terminally
 * instead of re-derived on every run. Callers that walk Discord therefore need
 * this, not the bare value.
 */
export type ChannelReadResult<T> = T | ChannelReadFailure | null;

/** DiscordChannelData plus the durable reason a read of it could never succeed. */
export type ChannelReadOutcome = ChannelReadResult<DiscordChannelData>;

/** A channel's name plus whether reading the channel can succeed at all. */
export interface ChannelNameOutcome {
	name: string | undefined;
	/** Why the read failed permanently, or null when it did not / is transient. */
	blockedReason: string | null;
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

	/**
	 * Get a single channel by ID. `null` when the channel is not readable and
	 * never will be (deleted, or the bot lacks access); a `ChannelReadFailure`
	 * when the read failed transiently. A walk that needs to distinguish a
	 * missing channel from a failed read must use this, not `getChannel`.
	 */
	readChannel(channelId: string): Promise<ChannelReadOutcome>;

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

	/**
	 * Resolve a channel's name (may require REST fallback). Fails terminally
	 * for an unreadable channel, which the caller must record rather than
	 * re-derive on every run.
	 */
	resolveChannelNameOutcome(channelId: string): Promise<ChannelNameOutcome>;

	/** Resolve a channel's name (may require REST fallback). */
	resolveChannelName(channelId: string): Promise<string | undefined>;

	/** Resolve a channel's type (may require REST fallback). */
	resolveChannelType(channelId: string): Promise<number | undefined>;

	/** Resolve the guild ID that a channel belongs to. */
	resolveGuildIdForChannel(channelId: string): Promise<string | undefined>;

	/** Fetch all active (non-archived) threads in a guild. */
	getActiveThreads(guildId: string): Promise<DiscordChannelData[]>;
}
