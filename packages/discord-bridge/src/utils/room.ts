/**
 * Room-related utility functions for Discord ↔ Roomy mapping.
 * All functions in this module are pure (no side effects).
 */

import { ROOM_KEY_PREFIX } from "../constants.js";

/**
 * Get the Roomy room mapping key for a Discord channel/thread ID.
 * Adds the "room:" prefix to distinguish from message mappings.
 *
 * This is necessary because Discord reuses message IDs as thread IDs when
 * creating threads from messages. Without this prefix, we'd have collisions
 * in the syncedIds mapping.
 *
 * @param discordChannelId - Discord channel/thread ID (string or bigint)
 * @returns Mapping key with "room:" prefix
 *
 * @example
 * ```ts
 * getRoomKey(123456789n)
 * // => "room:123456789"
 *
 * getRoomKey("987654321")
 * // => "room:987654321"
 * ```
 */
export function getRoomKey(discordChannelId: string | bigint): string {
  return ROOM_KEY_PREFIX + discordChannelId.toString();
}
