/**
 * Service for syncing reactions between Discord and Roomy.
 * Bidirectional sync (add and remove operations).
 *
 * This service handles reaction synchronization with idempotency tracking.
 */

import type { BridgeRepository } from "../repositories/index.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid, UserDid, type Event, type Did } from "@roomy/sdk";
import type { Emoji } from "@discordeno/bot";
import type { DiscordBot } from "../discord/types.js";
import { emojiToString, reactionKey as makeReactionKey } from "../utils/emoji.js";
import { DISCORD_EXTENSION_KEYS } from "../roomy/subscription.js";

/**
 * Service for syncing reactions between Discord and Roomy.
 */
export class ReactionSyncService {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly connectedSpace: ConnectedSpace,
    private readonly guildId: bigint,
    private readonly spaceId: string,
  ) {}

  /**
   * Sync a Discord reaction add to Roomy.
   *
   * @param messageId - Discord message ID
   * @param channelId - Discord channel ID
   * @param userId - Discord user ID
   * @param emoji - Discord emoji object
   * @returns The Roomy reaction event ID, or null if skipped
   *
   * @example
   * ```ts
   * const result = await service.syncAddToRoomy(
   *   123n,
   *   456n,
   *   789n,
   *   { name: "😀" }
   * );
   * ```
   */
  async syncAddToRoomy(
    messageId: bigint,
    channelId: bigint,
    userId: bigint,
    emoji: Partial<Emoji>,
  ): Promise<string | null> {
    const key = this.getReactionKey(messageId, userId, emoji);

    // Idempotency check - skip if already synced
    const existingReactionId = await this.repo.getReaction(key);
    if (existingReactionId) {
      return existingReactionId;
    }

    // Get the Roomy message ID for this Discord message
    const roomyMessageId = await this.repo.getRoomyId(messageId.toString());
    if (!roomyMessageId) {
      console.warn(`[ReactionSync] Message ${messageId} not synced, skipping reaction`);
      return null; // Message not synced
    }

    // Get the Roomy room ID for this channel
    const channelIdStr = channelId.toString();
    const roomKey = `room:${channelIdStr}`;
    const roomyRoomId = await this.repo.getRoomyId(roomKey);
    if (!roomyRoomId) {
      console.warn(`[ReactionSync] Channel ${channelId} not synced, skipping reaction`);
      return null; // Channel not synced
    }

    // Convert emoji to Roomy format
    const reactionString = emojiToString(emoji);

    // Build and send the AddBridgedReaction event
    const reactionId = newUlid();
    const event = {
      id: reactionId,
      room: roomyRoomId as any,
      $type: "space.roomy.reaction.addBridgedReaction.v0",
      reactionTo: roomyMessageId as any,
      reaction: reactionString,
      reactingUser: UserDid.assert(`did:discord:${userId}`),
      extensions: {
        [DISCORD_EXTENSION_KEYS.REACTION_ORIGIN]: {
          $type: DISCORD_EXTENSION_KEYS.REACTION_ORIGIN,
          snowflake: reactionId,
          messageId: messageId.toString(),
          channelId: channelIdStr,
          userId: userId.toString(),
          emoji: reactionString,
          guildId: this.guildId.toString(),
        },
      },
    } as Event;

    await this.connectedSpace.sendEvent(event);

    // Track the synced reaction
    await this.repo.setReaction(key, reactionId);

    return reactionId;
  }

  /**
   * Sync a Discord reaction remove to Roomy.
   *
   * @param messageId - Discord message ID
   * @param channelId - Discord channel ID
   * @param userId - Discord user ID
   * @param emoji - Discord emoji object
   *
   * @example
   * ```ts
   * await service.syncRemoveToRoomy(
   *   123n,
   *   456n,
   *   789n,
   *   { name: "😀" }
   * );
   * ```
   */
  async syncRemoveToRoomy(
    messageId: bigint,
    channelId: bigint,
    userId: bigint,
    emoji: Partial<Emoji>,
  ): Promise<void> {
    const key = this.getReactionKey(messageId, userId, emoji);

    // Get the Roomy reaction event ID
    const reactionEventId = await this.repo.getReaction(key);
    if (!reactionEventId) {
      return; // Reaction not found
    }

    // Get the Roomy room ID for this channel
    const channelIdStr = channelId.toString();
    const roomKey = `room:${channelIdStr}`;
    const roomyRoomId = await this.repo.getRoomyId(roomKey);
    if (!roomyRoomId) {
      return; // Channel not synced
    }

    // Build and send the RemoveBridgedReaction event
    const eventId = newUlid();
    const reactionString = emojiToString(emoji);
    const event = {
      id: eventId,
      room: roomyRoomId as any,
      $type: "space.roomy.reaction.removeBridgedReaction.v0",
      reactionId: reactionEventId as any,
      reactingUser: UserDid.assert(`did:discord:${userId}`),
      extensions: {
        [DISCORD_EXTENSION_KEYS.REACTION_ORIGIN]: {
          $type: DISCORD_EXTENSION_KEYS.REACTION_ORIGIN,
          snowflake: eventId,
          messageId: messageId.toString(),
          channelId: channelIdStr,
          userId: userId.toString(),
          emoji: reactionString,
          guildId: this.guildId.toString(),
        },
      },
    } as Event;

    await this.connectedSpace.sendEvent(event);

    // Remove from tracking
    await this.repo.deleteReaction(key);
  }

  /**
   * Generate a unique key for a reaction (for idempotency tracking).
   * Combines message ID, user ID, and emoji identifier into a single key.
   *
   * @param messageId - Discord message ID
   * @param userId - Discord user ID
   * @param emoji - Discord emoji object
   * @returns Unique key string for this reaction
   *
   * @example
   * ```ts
   * service.getReactionKey(123n, 456n, { name: "😀" })
   * // => "123:456:😀"
   *
   * service.getReactionKey(123n, 456n, { id: 789n, name: "pepe" })
   * // => "123:456:789"
   * ```
   */
  getReactionKey(messageId: bigint, userId: bigint, emoji: Partial<Emoji>): string {
    return makeReactionKey(messageId, userId, emoji);
  }

  // ============================================================
  // ROOMY → DISCORD sync methods
  // ============================================================

  /**
   * Sync a Roomy reaction add to Discord.
   *
   * @param roomyMessageId - Roomy message ULID being reacted to
   * @param roomyRoomId - Roomy room ULID
   * @param reaction - Emoji string (unicode or custom)
   * @param userDid - User DID who reacted
   * @param bot - Discord bot instance
   */
  async syncRoomyToDiscordAdd(
    roomyMessageId: string,
    roomyRoomId: string,
    reaction: string,
    userDid: Did,
    bot: DiscordBot,
  ): Promise<void> {
    // Get Discord message ID
    const discordId = await this.repo.getDiscordId(roomyMessageId);
    if (!discordId) {
      console.warn(`[ReactionSyncService] Roomy message ${roomyMessageId} not synced to Discord, skipping reaction`);
      return;
    }

    const messageId = BigInt(discordId.replace("room:", ""));

    // Get Discord channel ID
    const discordChannelId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordChannelId) {
      console.warn(`[ReactionSyncService] Room ${roomyRoomId} not synced to Discord, skipping reaction`);
      return;
    }

    const channelId = BigInt(discordChannelId.replace("room:", ""));

    // Parse user DID to get Discord user ID
    // Format: did:discord:123456789
    const userIdMatch = userDid.match(/^did:discord:(\d+)$/);
    if (!userIdMatch) {
      console.warn(`[ReactionSyncService] Cannot map user DID ${userDid} to Discord user, skipping reaction`);
      return;
    }

    const userId = BigInt(userIdMatch[1]!);

    // Idempotency check - use our own key format
    const key = `${roomyMessageId}:${userId}:${reaction}`;
    const existing = await this.repo.getReaction(key);
    if (existing) {
      return; // Already synced
    }

    try {
      // Parse reaction string to Discord emoji format
      // Unicode emoji: just use the string
      // Custom emoji: Discord uses format "name:id" (not the <:name:id> format)
      let emojiString = reaction;

      // Check if it's a custom emoji in format <:name:id> or <a:name:id>
      const emojiMatch = reaction.match(/^<?(a)?:([^:]+):(\d+)>?$/);
      if (emojiMatch) {
        // Convert to Discord API format: "name:id"
        emojiString = `${emojiMatch[2]}:${emojiMatch[3]!}`;
      }

      await bot.helpers.addReaction(channelId, messageId, emojiString);

      // Track the synced reaction
      await this.repo.setReaction(key, newUlid());

      console.log(`[ReactionSyncService] Added reaction ${reaction} to Discord message ${messageId}`);
    } catch (error) {
      console.error(`[ReactionSyncService] Error adding reaction to Discord:`, error);
    }
  }

  /**
   * Sync a Roomy reaction remove to Discord.
   *
   * @param reactionEventId - Roomy reaction event ULID to remove
   * @param roomyRoomId - Roomy room ULID
   * @param userDid - User DID who removed the reaction
   * @param bot - Discord bot instance
   */
  async syncRoomyToDiscordRemove(
    reactionEventId: string,
    roomyRoomId: string,
    userDid: Did,
    bot: DiscordBot,
  ): Promise<void> {
    // Parse user DID to get Discord user ID
    const userIdMatch = userDid.match(/^did:discord:(\d+)$/);
    if (!userIdMatch) {
      console.warn(`[ReactionSyncService] Cannot map user DID ${userDid} to Discord user, skipping reaction removal`);
      return;
    }

    const userId = BigInt(userIdMatch[1]!);

    // Get Discord channel ID
    const discordChannelId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordChannelId) {
      console.warn(`[ReactionSyncService] Room ${roomyRoomId} not synced to Discord, skipping reaction removal`);
      return;
    }

    const channelId = BigInt(discordChannelId.replace("room:", ""));

    // Find the reaction to remove by looking up our tracking
    // We need to iterate through tracked reactions to find the one matching this event
    // This is a limitation of our current tracking - we track by Discord key, not Roomy event ID
    // For now, we'll use a simple approach: find by prefix matching
    // A better approach would be to store bidirectional mapping

    // Note: This is a simplified approach. In a production system,
    // we'd need a more sophisticated tracking mechanism.
    // For now, we'll just log a warning since we can't easily
    // map back from the Roomy reaction event ID to the Discord reaction
    console.warn(`[ReactionSyncService] Cannot remove Discord reaction for Roomy event ${reactionEventId} - mapping not implemented`);

    // TODO: Implement proper reverse lookup for reaction removal
    // We'd need to:
    // 1. Store Roomy reaction event ID -> Discord reaction key mapping
    // 2. Query that mapping here
    // 3. Parse the emoji and user from the key
    // 4. Call bot.helpers.deleteOwnReaction() or bot.helpers.deleteUserReaction()
  }
}
