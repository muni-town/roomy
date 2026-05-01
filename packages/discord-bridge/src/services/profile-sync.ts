import { newUlid, type Did, type Event } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import { computeProfileHash } from "../utils/hash.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("profile");

export interface DiscordUserProfile {
  id: bigint;
  username: string;
  globalName?: string;
  avatar?: bigint;
  discriminator: string;
}

function discordAvatarUrl(userId: bigint, avatar: bigint | undefined, discriminator: string): string {
  if (avatar) {
    return `https://cdn.discordapp.com/avatars/${userId}/${avatar.toString(16)}.webp?size=256`;
  }
  const mod = discriminator !== "0"
    ? parseInt(discriminator) % 5
    : 0;
  return `https://cdn.discordapp.com/embed/avatars/${mod}.png`;
}

/**
 * Sync a Discord user profile to Roomy for all target spaces.
 * Uses hash-based change detection to skip unchanged profiles.
 */
export async function syncUserProfile(
  user: DiscordUserProfile,
  targetSpaces: string[],
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const userIdStr = user.id.toString();
  const avatarHex = user.avatar?.toString(16) ?? null;
  const hash = computeProfileHash(
    user.username,
    user.globalName ?? null,
    avatarHex,
  );

  const avatar = discordAvatarUrl(user.id, user.avatar, user.discriminator);
  const handle = user.discriminator !== "0"
    ? `${user.username}#${user.discriminator}`
    : user.username;

  for (const spaceDid of targetSpaces) {
    const existingHash = repo.getProfileHash(spaceDid, userIdStr);
    if (existingHash === hash) continue;

    const event: Event = {
      id: newUlid(),
      $type: "space.roomy.user.updateProfile.v0",
      did: `did:discord:${userIdStr}` as Did,
      name: user.globalName ?? user.username,
      avatar,
      extensions: {
        "space.roomy.extension.discordUserOrigin.v0": {
          $type: "space.roomy.extension.discordUserOrigin.v0",
          snowflake: userIdStr,
          profileHash: hash,
          handle,
        },
      },
    };

    try {
      const connected = await spaceManager.getOrConnect(spaceDid);
      await connected.sendEvent(event);
      repo.setProfileHash(spaceDid, userIdStr, hash);
      log.info(`Synced profile for Discord user ${userIdStr} to ${spaceDid}`);
    } catch (err) {
      log.error(`Failed to sync profile for Discord user ${userIdStr} to ${spaceDid}`, err);
    }
  }
}
