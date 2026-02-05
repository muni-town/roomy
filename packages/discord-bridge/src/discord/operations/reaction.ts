/**
 * Reaction operations for Discord.
 * High-level functions for adding and removing reactions.
 */

import type { DiscordBot } from "../types.js";

/**
 * Options for adding a reaction.
 */
export interface AddReactionOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Discord message ID to react to */
  messageId: bigint;
  /** Emoji to react with (unicode or custom emoji format) */
  emoji: string;
}

/**
 * Result of adding a reaction.
 */
export interface AddReactionResult {
  success: true;
}

/**
 * Add a reaction to a message.
 *
 * @param bot - Discord bot instance
 * @param options - Reaction add options
 * @returns Success indicator
 *
 * @example
 * ```ts
 * await addReaction(bot, {
 *   channelId: 123456789n,
 *   messageId: 987654321n,
 *   emoji: "👍",
 * });
 * ```
 */
export async function addReaction(
  bot: DiscordBot,
  options: AddReactionOptions,
): Promise<AddReactionResult> {
  await bot.helpers.addReaction(
    options.channelId,
    options.messageId,
    options.emoji,
  );
  return { success: true };
}

/**
 * Options for removing a reaction.
 */
export interface RemoveReactionOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Discord message ID */
  messageId: bigint;
  /** Emoji to remove */
  emoji: string;
  /** User ID whose reaction to remove (if removing another user's reaction) */
  userId?: bigint;
}

/**
 * Result of removing a reaction.
 */
export interface RemoveReactionResult {
  success: true;
}

/**
 * Remove a reaction from a message.
 *
 * @param bot - Discord bot instance
 * @param options - Reaction remove options
 * @returns Success indicator
 *
 * @example
 * ```ts
 * // Remove bot's own reaction
 * await removeReaction(bot, {
 *   channelId: 123456789n,
 *   messageId: 987654321n,
 *   emoji: "👍",
 * });
 *
 * // Remove a specific user's reaction
 * await removeReaction(bot, {
 *   channelId: 123456789n,
 *   messageId: 987654321n,
 *   emoji: "👍",
 *   userId: 111222333n,
 * });
 * ```
 */
export async function removeReaction(
  bot: DiscordBot,
  options: RemoveReactionOptions,
): Promise<RemoveReactionResult> {
  if (options.userId) {
    // Remove a specific user's reaction
    await bot.helpers.deleteUserReaction(
      options.channelId,
      options.messageId,
      options.emoji,
      options.userId,
    );
  } else {
    // Remove bot's own reaction
    await bot.helpers.deleteOwnReaction(
      options.channelId,
      options.messageId,
      options.emoji,
    );
  }
  return { success: true };
}

/**
 * Options for removing all reactions for an emoji.
 */
export interface RemoveAllReactionsOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Discord message ID */
  messageId: bigint;
  /** Emoji to remove all reactions for */
  emoji: string;
}

/**
 * Result of removing all reactions for an emoji.
 */
export interface RemoveAllReactionsResult {
  success: true;
}

/**
 * Remove all reactions for a specific emoji from a message.
 *
 * @param bot - Discord bot instance
 * @param options - Remove all reactions options
 * @returns Success indicator
 *
 * @example
 * ```ts
 * await removeAllReactions(bot, {
 *   channelId: 123456789n,
 *   messageId: 987654321n,
 *   emoji: "👍",
 * });
 * ```
 */
export async function removeAllReactions(
  bot: DiscordBot,
  options: RemoveAllReactionsOptions,
): Promise<RemoveAllReactionsResult> {
  await bot.helpers.deleteAllReactionsForEmoji(
    options.channelId,
    options.messageId,
    options.emoji,
  );
  return { success: true };
}

/**
 * Options for removing all reactions from a message.
 */
export interface ClearAllReactionsOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Discord message ID */
  messageId: bigint;
}

/**
 * Result of clearing all reactions.
 */
export interface ClearAllReactionsResult {
  success: true;
}

/**
 * Remove all reactions from a message.
 *
 * @param bot - Discord bot instance
 * @param options - Clear all reactions options
 * @returns Success indicator
 *
 * @example
 * ```ts
 * await clearAllReactions(bot, {
 *   channelId: 123456789n,
 *   messageId: 987654321n,
 * });
 * ```
 */
export async function clearAllReactions(
  bot: DiscordBot,
  options: ClearAllReactionsOptions,
): Promise<ClearAllReactionsResult> {
  await bot.helpers.deleteAllReactions(options.channelId, options.messageId);
  return { success: true };
}
