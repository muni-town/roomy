/**
 * Constants used throughout the Discord bridge.
 * Centralized for maintainability and testability.
 */

/**
 * Discord message types that should not be synced as regular messages.
 * @see https://discord.com/developers/docs/resources/channel#message-object-message-types
 */
export const DISCORD_MESSAGE_TYPES = {
  /** Default message - normal user message */
  DEFAULT: 0,
  /** Channel/thread rename system message */
  CHANNEL_NAME_CHANGE: 4,
  /** System message announcing thread creation */
  THREAD_CREATED: 18,
  /** A reply to another message */
  REPLY: 19,
  /** First message in a thread created from existing message */
  THREAD_STARTER_MESSAGE: 21,
} as const;

/**
 * Key prefix for room/channel/thread mappings to distinguish from message mappings.
 *
 * This is necessary because Discord reuses message IDs as thread IDs when creating
 * threads from messages. Without this prefix, we'd have collisions between message
 * and room IDs in the syncedIds mapping.
 *
 * @example
 * ```ts
 * // Channel mapping
 * "room:123456789" -> "01HZ..."
 *
 * // Message mapping (no prefix)
 * "987654321" -> "01HJ..."
 *
 * // Thread mapping
 * "room:987654321" -> "01HK..."
 * ```
 */
export const ROOM_KEY_PREFIX = "room:" as const;
