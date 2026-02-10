/**
 * Service for syncing user profiles from Discord to Roomy.
 * Unidirectional sync (Discord → Roomy only).
 *
 * This service uses hash-based change detection to avoid redundant profile updates.
 */

import { avatarUrl } from "@discordeno/bot";
import type { BridgeRepository } from "../repositories/index.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid, type Did, type Event, type DecodedStreamEvent } from "@roomy/sdk";
import { computeProfileHash as fingerprint } from "../utils/hash.js";
import { DISCORD_EXTENSION_KEYS, extractDiscordUserOrigin } from "../utils/event-extensions.js";

/**
 * Discord user profile data for syncing.
 */
export interface DiscordUser {
  id: bigint;
  username: string;
  discriminator: string;
  globalName?: string | null;
  avatar?: string | null;
}

/**
 * Optional batcher for bulk operations.
 */
export interface EventBatcher {
  add(event: Event): Promise<void>;
}

/**
 * Service for syncing Discord user profiles to Roomy.
 * Uses hash-based change detection for idempotency.
 */
export class ProfileSyncService {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly connectedSpace: ConnectedSpace,
    private readonly guildId: bigint,
  ) {}

  /**
   * Sync a Discord user profile to Roomy.
   * Uses hash-based change detection to avoid redundant updates.
   *
   * @param discordUser - Discord user to sync
   * @param batcher - Optional event batcher for bulk operations
   *
   * @example
   * ```ts
   * await service.syncDiscordToRoomy({
   *   id: 123456789n,
   *   username: "user",
   *   discriminator: "0001",
   *   globalName: "User",
   *   avatar: "abc123",
   * });
   * ```
   */
  async syncDiscordToRoomy(
    discordUser: DiscordUser,
    batcher?: EventBatcher,
  ): Promise<void> {
    const userIdStr = discordUser.id.toString();

    // Compute profile hash for change detection
    const hash = this.computeProfileHash(discordUser);

    // Check if profile already synced with same hash
    const existingHash = await this.repo.getProfileHash(userIdStr);
    if (existingHash === hash) {
      return; // No change - idempotent
    }

    // Build avatar URL using discordeno helper
    const userAvatarUrl = avatarUrl(discordUser.id, discordUser.discriminator, {
      avatar: discordUser.avatar ?? undefined,
      size: 256,
      format: "webp",
    });

    // Build the DID for the user
    const did = `did:discord:${userIdStr}` as Did;

    // Send profile update event
    const event: Event = {
      id: newUlid(),
      $type: "space.roomy.user.updateProfile.v0",
      did,
      name: discordUser.globalName ?? discordUser.username,
      avatar: userAvatarUrl,
      extensions: {
        [DISCORD_EXTENSION_KEYS.USER_ORIGIN]: {
          $type: DISCORD_EXTENSION_KEYS.USER_ORIGIN,
          snowflake: userIdStr,
          guildId: this.guildId.toString(),
          profileHash: hash,
          handle: `${discordUser.username}#${discordUser.discriminator}`,
        },
      },
    };

    if (batcher) {
      await batcher.add(event);
    } else {
      await this.connectedSpace.sendEvent(event);
    }

    // Update hash cache
    await this.repo.setProfileHash(userIdStr, hash);
  }

  /**
   * Compute a fingerprint hash for a Discord user profile.
   * Used for change detection to avoid redundant profile updates.
   *
   * @param user - Discord user to hash
   * @returns 32-character hex string
   *
   * @example
   * ```ts
   * const hash = service.computeProfileHash({
   *   id: 123n,
   *   username: "user",
   *   discriminator: "0001",
   *   globalName: "User",
   *   avatar: "abc123",
   * });
   * ```
   */
  computeProfileHash(user: DiscordUser): string {
    return fingerprint(
      user.username,
      user.globalName ?? null,
      user.avatar ?? null,
    );
  }

  /**
   * Handle a Roomy event from the subscription stream.
   * Processes profile-related events and caches profile data.
   *
   * @param decoded - The decoded Roomy event
   * @returns true if the event was handled, false otherwise
   */
  async handleRoomyEvent(decoded: DecodedStreamEvent): Promise<boolean> {
    try {
      const { event } = decoded;

      // Handle updateProfile
      if (event.$type === "space.roomy.user.updateProfile.v0") {
        const e = event as any;

        // Check for Discord user origin
        const userOrigin = extractDiscordUserOrigin(event);

        // Cache Discord user profile hash
        if (userOrigin && userOrigin.guildId === this.guildId.toString()) {
          await this.repo.setProfileHash(userOrigin.snowflake, userOrigin.profileHash);
          return true; // Handled
        }

        // Cache Roomy user profile (non-Discord users)
        if (e.did) {
          await this.repo.setRoomyUserProfile(e.did, {
            name: e.name || "Unknown",
            avatar: e.avatar ?? null,
          });
          console.log(
            `[Profile Capture] Cached Roomy user profile: did=${e.did}, name=${e.name || "Unknown"}`,
          );
        }
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[ProfileSyncService] Error handling Roomy event:`, error);
      return false;
    }
  }
}
