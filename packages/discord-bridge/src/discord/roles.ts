/**
 * Bot-managed role utilities for per-bridge Discord roles (subset mode).
 *
 * In subset mode, the bot creates a role named "Roomy: <spaceName>" and
 * sets VIEW_CHANNEL: Allow on the selected channels. Deleting the role
 * auto-removes the permission overwrites.
 */

import type { DiscordBot } from "./types.js";

/** VIEW_CHANNEL permission bit (0x400 = 1 << 10) */
const VIEW_CHANNEL = 0x400n;

/**
 * Create a bot-managed role for a subset bridge.
 * @returns The role snowflake as a string
 */
export async function createBridgeRole(
  bot: DiscordBot,
  guildId: bigint,
  spaceName: string,
): Promise<string> {
  const roleName = `Roomy: ${spaceName}`;
  const role = await bot.helpers.createRole(guildId, {
    name: roleName,
    mentionable: false,
  });
  const roleId = (role as any).id?.toString();
  console.log(
    `[roles] Created bridge role "${roleName}" (${roleId}) in guild ${guildId}`,
  );
  return roleId;
}

/**
 * Delete a bot-managed bridge role.
 * Deleting the role automatically removes all its permission overwrites from channels.
 */
export async function deleteBridgeRole(
  bot: DiscordBot,
  guildId: bigint,
  roleId: string,
): Promise<void> {
  try {
    await bot.helpers.deleteRole(guildId, BigInt(roleId));
    console.log(`[roles] Deleted bridge role ${roleId} from guild ${guildId}`);
  } catch (error) {
    console.warn(
      `[roles] Failed to delete bridge role ${roleId} (may already be deleted):`,
      error,
    );
  }
}

/**
 * Set VIEW_CHANNEL: Allow permission overwrite for a role on specified channels.
 */
export async function setChannelBridgePermissions(
  bot: DiscordBot,
  channelIds: string[],
  roleId: string,
): Promise<void> {
  await Promise.all(
    channelIds.map(async (channelId) => {
      try {
        await bot.helpers.editChannelPermissionOverrides(BigInt(channelId), {
          id: BigInt(roleId),
          type: 0, // Role type
          allow: ["VIEW_CHANNEL"],
          deny: [],
        });
      } catch (error) {
        console.warn(
          `[roles] Failed to set permissions on channel ${channelId}:`,
          error,
        );
      }
    }),
  );

  console.log(
    `[roles] Set VIEW_CHANNEL permissions for role ${roleId} on ${channelIds.length} channel(s)`,
  );
}
