/**
 * Emoji-related utility functions for Discord ↔ Roomy sync.
 * All functions in this module are pure (no side effects).
 */

import type { Emoji } from "@discordeno/bot";

/**
 * Convert Discord emoji to a string representation for Roomy.
 * Custom emojis use their ID, unicode emojis use their name.
 *
 * @param emoji - Partial Discord emoji object
 * @returns String representation of the emoji
 *
 * @example
 * ```ts
 * // Custom emoji
 * emojiToString({ id: 123456n, name: "nyan", animated: false })
 * // => "<:nyan:123456>"
 *
 * // Animated custom emoji
 * emojiToString({ id: 123456n, name: "nyan", animated: true })
 * // => "<a:nyan:123456>"
 *
 * // Unicode emoji
 * emojiToString({ name: "😀" })
 * // => "😀"
 * ```
 */
export function emojiToString(emoji: Partial<Emoji>): string {
  // Custom emoji - use the format <:name:id> or <a:name:id> for animated
  if (emoji.id) {
    const animated = emoji.animated ? "a" : "";
    return `<${animated}:${emoji.name || "_"}:${emoji.id}>`;
  }
  // Unicode emoji - just use the name (which is the emoji character)
  return emoji.name || "❓";
}

/**
 * Generate a unique key for a reaction (for idempotency tracking).
 * Combines message ID, user ID, and emoji identifier into a single key.
 *
 * @param messageId - Discord message ID (snowflake)
 * @param userId - Discord user ID (snowflake)
 * @param emoji - Partial Discord emoji object
 * @returns Unique key string for this reaction
 *
 * @example
 * ```ts
 * reactionKey(123456n, 789012n, { id: 999n, name: "pepe" })
 * // => "123456:789012:999"
 *
 * reactionKey(123456n, 789012n, { name: "😀" })
 * // => "123456:789012:😀"
 * ```
 */
export function reactionKey(
  messageId: bigint,
  userId: bigint,
  emoji: Partial<Emoji>,
): string {
  const emojiKey = emoji.id ? emoji.id.toString() : emoji.name || "unknown";
  return `${messageId}:${userId}:${emojiKey}`;
}
