/**
 * Channel operations for Discord.
 * High-level functions for creating and managing channels and threads.
 */

import type { DiscordBot } from "../types.js";

/**
 * Discord channel types (subset).
 */
export type DiscordChannelType =
  | 0 // GUILD_TEXT
  | 2 // GUILD_VOICE
  | 4 // GUILD_CATEGORY
  | 5 // GUILD_NEWS
  | 11 // GUILD_NEWS_THREAD
  | 12 // GUILD_PUBLIC_THREAD
  | 15; // GUILD_FORUM

/**
 * Options for creating a channel.
 */
export interface CreateChannelOptions {
  /** Discord guild ID */
  guildId: bigint;
  /** Channel name */
  name: string;
  /** Channel type */
  type: DiscordChannelType;
  /** Parent category ID (optional) */
  parentId?: bigint;
  /** Topic/description (optional) */
  topic?: string;
}

/**
 * Result of creating a channel.
 */
export interface CreateChannelResult {
  /** Discord channel snowflake */
  id: bigint;
}

/**
 * Create a Discord channel.
 *
 * @param bot - Discord bot instance
 * @param options - Channel creation options
 * @returns The created channel ID
 *
 * @example
 * ```ts
 * const result = await createChannel(bot, {
 *   guildId: 123456789n,
 *   name: "new-channel",
 *   type: 0, // GUILD_TEXT
 * });
 * ```
 */
export async function createChannel(
  bot: DiscordBot,
  options: CreateChannelOptions,
): Promise<CreateChannelResult> {
  const channel = await bot.helpers.createChannel(options.guildId, {
    name: options.name,
    type: options.type,
    ...(options.parentId && { parentId: options.parentId.toString() }),
    ...(options.topic && { topic: options.topic }),
  });

  return { id: channel.id };
}

/**
 * Options for creating a thread.
 */
export interface CreateThreadOptions {
  /** Discord channel ID to create thread in */
  channelId: bigint;
  /** Thread name */
  name: string;
  /** Message ID to create thread from (optional) */
  messageId?: bigint;
}

/**
 * Result of creating a thread.
 */
export interface CreateThreadResult {
  /** Discord thread snowflake */
  id: bigint;
}

/**
 * Create a thread in a channel.
 *
 * @param bot - Discord bot instance
 * @param options - Thread creation options
 * @returns The created thread ID
 *
 * @example
 * ```ts
 * // Create a public thread from a message
 * const result = await createThread(bot, {
 *   channelId: 123456789n,
 *   name: "Thread name",
 *   messageId: 987654321n,
 * });
 * ```
 */
export async function createThread(
  bot: DiscordBot,
  options: CreateThreadOptions,
): Promise<CreateThreadResult> {
  if (options.messageId) {
    // Create thread from message
    const thread = await bot.helpers.startThreadWithMessage(
      options.channelId,
      options.messageId,
      {
        name: options.name,
        autoArchiveDuration: 1440, // 7 days in minutes
      },
    );
    return { id: thread.id };
  } else {
    // Create thread without message
    const thread = await bot.helpers.startThreadWithoutMessage(
      options.channelId,
      {
        name: options.name,
        autoArchiveDuration: 1440, // 7 days in minutes
        type: 11, // PUBLIC_THREAD
      },
    );
    return { id: thread.id };
  }
}

/**
 * Options for fetching a channel.
 */
export interface FetchChannelOptions {
  /** Discord channel ID */
  channelId: bigint;
}

/**
 * Result of fetching a channel.
 */
export interface FetchChannelResult {
  id: bigint;
  name: string;
  type: number;
  guildId: bigint;
  parentId?: bigint | null;
  lastMessageId?: bigint | null;
}

/**
 * Fetch a Discord channel.
 *
 * @param bot - Discord bot instance
 * @param options - Channel fetch options
 * @returns The fetched channel
 *
 * @example
 * ```ts
 * const channel = await fetchChannel(bot, {
 *   channelId: 123456789n,
 * });
 * ```
 */
export async function fetchChannel(
  bot: DiscordBot,
  options: FetchChannelOptions,
): Promise<FetchChannelResult> {
  const channel = await bot.helpers.getChannel(options.channelId);

  return {
    id: channel.id,
    name: channel.name || "",
    type: channel.type,
    guildId: channel.guildId || 0n,
    parentId: channel.parentId || null,
    lastMessageId: channel.lastMessageId || null,
  };
}
