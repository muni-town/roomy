/**
 * Service for syncing user profiles from Discord to Roomy.
 * Unidirectional sync (Discord → Roomy only).
 *
 * This service uses hash-based change detection to avoid redundant profile updates.
 */

import { avatarUrl } from "@discordeno/bot";
import type { BridgeRepository, RoomyUserProfile } from "../repositories/index.js";
import type { ConnectedSpace, StreamDid, Ulid } from "@roomy/sdk";
import {
  newUlid,
  type Did,
  type Event,
  type DecodedStreamEvent,
} from "@roomy/sdk";
import type { Agent } from "@atproto/api";
import { computeProfileHash as fingerprint } from "../utils/hash.js";
import {
  DISCORD_EXTENSION_KEYS,
  extractDiscordUserOrigin,
} from "../utils/event-extensions.js";
import type { EventDispatcher } from "../dispatcher.js";

/**
 * Simple LRU cache for profile data.
 * Bounded by maximum entries to prevent memory bloat.
 */
class ProfileCache {
  private cache = new Map<string, RoomyUserProfile>();
  private accessOrder: string[] = [];

  constructor(private readonly maxSize: number = 50) {}

  get(key: string): RoomyUserProfile | undefined {
    const value = this.cache.get(key);
    if (value) {
      // Move to end of access order (most recently used)
      this.accessOrder = this.accessOrder.filter((k) => k !== key);
      this.accessOrder.push(key);
    }
    return value;
  }

  set(key: string, value: RoomyUserProfile): void {
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.accessOrder.shift();
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, value);

    // Update access order
    this.accessOrder = this.accessOrder.filter((k) => k !== key);
    this.accessOrder.push(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.cache.size;
  }
}

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
 * Service for syncing Discord user profiles to Roomy.
 * Uses hash-based change detection for idempotency.
 */
export class ProfileSyncService {
  private profileCache: ProfileCache;

  constructor(
    private readonly repo: BridgeRepository,
    private readonly spaceId: StreamDid,
    private readonly dispatcher: EventDispatcher,
    private readonly guildId: bigint,
    cacheSize: number = 50,
  ) {
    // Initialize in-memory LRU cache for Roomy user profiles
    this.profileCache = new ProfileCache(cacheSize);
  }

  /**
   * Sync a Discord user profile to Roomy.
   * Uses hash-based change detection to avoid redundant updates.
   *
   * @param discordUser - Discord user to sync
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
  async syncDiscordToRoomy(discordUser: DiscordUser): Promise<void> {
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

    this.dispatcher.toRoomy.push(event);

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
  async handleRoomyEvent(
    decoded: DecodedStreamEvent,
    batchId: Ulid,
    isLastEvent: boolean,
  ): Promise<boolean> {
    try {
      const { event } = decoded;

      // Handle updateProfile
      if (event.$type === "space.roomy.user.updateProfile.v0") {
        const e = event as any;

        // Check for Discord user origin
        const userOrigin = extractDiscordUserOrigin(event);

        // Cache Discord user profile hash
        if (userOrigin && userOrigin.guildId === this.guildId.toString()) {
          await this.repo.setProfileHash(
            userOrigin.snowflake,
            userOrigin.profileHash,
          );
          return true; // Handled
        }

        // Cache Roomy user profile (non-Discord users)
        if (e.did) {
          const profile: RoomyUserProfile = {
            name: e.name || "Unknown",
            avatar: e.avatar ?? null,
          };
          await this.repo.setRoomyUserProfile(e.did, profile);
          this.profileCache.set(e.did, profile);
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

  /**
   * Get user profile with automatic Bluesky fetching.
   * Priority:
   * 1. In-memory LRU cache (fastest - from updateProfile events or previous fetches)
   * 2. LevelDB persistent cache (from updateProfile events)
   * 3. Fetch from Bluesky (if not fetched recently, i.e., >1 hour ago)
   * 4. Return undefined if not found
   *
   * @param did - User DID to fetch profile for
   * @param agent - Agent instance for fetching from Bluesky
   * @returns Profile or undefined
   *
   * @example
   * ```ts
   * const profile = await service.getProfileOrFetch(userDid, agent);
   * if (profile) {
   *   username = profile.name;
   *   avatarUrl = profile.avatar ?? undefined;
   * }
   * ```
   */
  async getProfileOrFetch(
    did: string,
    agent: Agent,
  ): Promise<RoomyUserProfile | undefined> {
    // 1. Check in-memory cache first (fastest - updateProfile events + previous fetches)
    if (this.profileCache.has(did)) {
      const cached = this.profileCache.get(did);
      if (cached) {
        console.log(
          `[Profile Puppeting] Memory cache hit for ${did}: ${cached.name}`,
        );
        return cached;
      }
    }

    // 2. Check LevelDB persistent cache (from updateProfile events)
    const dbCached = await this.repo.getRoomyUserProfile(did);
    if (dbCached) {
      // Populate memory cache
      this.profileCache.set(did, dbCached);
      console.log(
        `[Profile Puppeting] DB cache hit for ${did}: ${dbCached.name}`,
      );
      return dbCached;
    }

    // 3. Check if we've recently tried fetching (avoid excessive calls)
    const lastFetch = await this.repo.getBlueskyFetchAttempt(did);
    const FETCH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

    if (lastFetch && Date.now() - lastFetch < FETCH_COOLDOWN_MS) {
      // Tried recently and failed, don't retry yet
      console.log(
        `[Profile Puppeting] Fetch cooldown active for ${did} (last fetch ${Math.round((Date.now() - lastFetch) / 1000)}s ago)`,
      );
      return undefined;
    }

    // 4. Record this fetch attempt
    await this.repo.setBlueskyFetchAttempt(did, Date.now());

    // 5. Fetch from Bluesky
    try {
      // Dynamic import to avoid circular dependencies
      const { getProfile } = await import("@roomy/sdk");
      const atpProfile = await getProfile(agent, did as Did);

      if (atpProfile) {
        const profile: RoomyUserProfile = {
          name: atpProfile.displayName || atpProfile.handle,
          avatar: atpProfile.avatar ?? null,
          handle: atpProfile.handle,
        };

        // Cache in both memory and DB
        this.profileCache.set(did, profile);
        await this.repo.setRoomyUserProfile(did, profile);
        console.log(
          `[Profile Puppeting] Fetched and cached profile for ${did}: ${profile.name}`,
        );
        return profile;
      } else {
        console.log(
          `[Profile Puppeting] No Bluesky profile found for ${did}`,
        );
      }
    } catch (e) {
      console.error(
        `[Profile Puppeting] Failed to fetch Bluesky profile for ${did}:`,
        e,
      );
    }

    return undefined;
  }
}
