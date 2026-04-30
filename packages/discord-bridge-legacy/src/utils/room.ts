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

/** The Discord role name that controls which channels are bridged. */
export const BRIDGE_ROLE_NAME = "Roomy Bridge";

/** VIEW_CHANNEL permission bit (0x400 = 1 << 10) */
const VIEW_CHANNEL_BIT = 1n << 10n;

/**
 * Check if a Discord channel should be bridged to Roomy.
 *
 * Two modes depending on whether a "Roomy Bridge" role exists in the guild:
 *
 * 1. **With bridge role** (opt-in): Only bridge channels where the role has
 *    an explicit `VIEW_CHANNEL: Allow` overwrite. Channels without an overwrite
 *    for this role are NOT bridged.
 *
 * 2. **Without bridge role** (fallback): Bridge all public channels — i.e.,
 *    channels where `@everyone` is NOT denied `VIEW_CHANNEL`.
 *
 * Handles both raw REST API format (allow/deny as string bitfield) and
 * transformed gateway format (allow/deny as PermissionStrings[]).
 *
 * @param permissionOverwrites - Channel permission overwrites (raw or transformed)
 * @param guildId - Guild ID (bigint) — the @everyone role has the same ID
 * @param bridgeRoleId - ID of the "Roomy Bridge" role, or null if it doesn't exist
 * @returns true if the channel should be bridged
 */
export function isChannelBridgeApproved(
  permissionOverwrites: any[] | undefined,
  guildId: bigint,
  bridgeRoleId: bigint | null,
): boolean {
  if (!permissionOverwrites) {
    // No overwrites: public channel (bridged in fallback mode), not opted-in (not bridged in role mode)
    return bridgeRoleId === null;
  }

  if (bridgeRoleId !== null) {
    // Opt-in mode: look for explicit VIEW_CHANNEL: Allow on the bridge role
    const roleOverwrite = permissionOverwrites.find(
      (ow) => ow.id.toString() === bridgeRoleId.toString() && ow.type === 0,
    );
    if (!roleOverwrite) return false; // No overwrite for this role = not bridged

    const allow = roleOverwrite.allow;
    if (!allow) return false;

    if (Array.isArray(allow)) {
      return allow.includes("VIEW_CHANNEL");
    }
    return (BigInt(allow) & VIEW_CHANNEL_BIT) !== 0n;
  }

  // Fallback mode: bridge all public channels (@everyone not denied VIEW_CHANNEL)
  const guildIdStr = guildId.toString();
  const everyoneOverwrite = permissionOverwrites.find(
    (ow) => ow.id.toString() === guildIdStr && ow.type === 0,
  );

  if (!everyoneOverwrite) return true;

  const deny = everyoneOverwrite.deny;
  if (!deny) return true;

  if (Array.isArray(deny)) {
    return !deny.includes("VIEW_CHANNEL");
  }
  return (BigInt(deny) & VIEW_CHANNEL_BIT) === 0n;
}
