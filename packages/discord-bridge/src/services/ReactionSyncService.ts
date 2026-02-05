/**
 * Service for syncing reactions between Discord and Roomy.
 * Bidirectional sync (add and remove operations).
 *
 * This service handles reaction synchronization with idempotency tracking.
 */

import type { BridgeRepository } from "../repositories/index.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid, UserDid, type Event } from "@roomy/sdk";
import type { Emoji } from "@discordeno/bot";
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
      return null; // Message not synced
    }

    // Get the Roomy room ID for this channel
    const channelIdStr = channelId.toString();
    const roomKey = `room:${channelIdStr}`;
    const roomyRoomId = await this.repo.getRoomyId(roomKey);
    if (!roomyRoomId) {
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
}
