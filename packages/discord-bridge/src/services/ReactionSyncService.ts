/**
 * Service for syncing reactions between Discord and Roomy.
 * Bidirectional sync (add and remove operations).
 *
 * This service handles reaction synchronization with idempotency tracking.
 */

import type { BridgeRepository } from "../repositories/index.js";
import type { StreamDid, Ulid } from "@roomy/sdk";
import {
  newUlid,
  UserDid,
  type Event,
  type Did,
  type DecodedStreamEvent,
} from "@roomy/sdk";
import type { Emoji } from "@discordeno/bot";
import type { DiscordBot } from "../discord/types.js";
import {
  emojiToString,
  reactionKey as makeReactionKey,
} from "../utils/emoji.js";
import {
  DISCORD_EXTENSION_KEYS,
  extractDiscordReactionOrigin,
} from "../utils/event-extensions.js";
import type { EventDispatcher } from "../dispatcher.js";
import { getRoomKey } from "../utils/room.js";

/**
 * Service for syncing reactions between Discord and Roomy.
 */
export class ReactionSyncService {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly spaceId: StreamDid,
    private readonly dispatcher: EventDispatcher,
    private readonly guildId: bigint,
    private readonly bot: DiscordBot,
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
    // Skip bot's own reactions to prevent reaction echo
    // When we sync a Roomy reaction to Discord via webhook, Discord sends us
    // a reaction_add event back. We must skip syncing this back to Roomy.
    if (userId === this.bot.id) {
      console.log(
        `[ReactionSync] Skipping bot's own reaction (user ${userId} == bot ${this.bot.id})`,
      );
      return null;
    }

    const key = this.getReactionKey(messageId, userId, emoji);

    // Idempotency check - skip if already synced
    const existingReactionId = await this.repo.getReaction(key);
    if (existingReactionId) {
      return existingReactionId;
    }

    // Get the Roomy message ID for this Discord message
    const roomyMessageId = await this.repo.getRoomyId(messageId.toString());
    if (!roomyMessageId) {
      console.warn(
        `[ReactionSync] Message ${messageId} not synced, skipping reaction`,
      );
      return null; // Message not synced
    }

    // Get the Roomy room ID for this channel
    const channelIdStr = channelId.toString();
    const roomKey = `room:${channelIdStr}`;
    const roomyRoomId = await this.repo.getRoomyId(roomKey);
    if (!roomyRoomId) {
      console.warn(
        `[ReactionSync] Channel ${channelId} not synced, skipping reaction`,
      );
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

    this.dispatcher.toRoomy.push(event);

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
    const roomKey = getRoomKey(channelIdStr);
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

    this.dispatcher.toRoomy.push(event);

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
  getReactionKey(
    messageId: bigint,
    userId: bigint,
    emoji: Partial<Emoji>,
  ): string {
    return makeReactionKey(messageId, userId, emoji);
  }

  /**
   * Backfill Discord reactions to Roomy for specified channels.
   * Fetches all messages and their reactions, syncing to Roomy.
   *
   * @param channelIds - Discord channel IDs to backfill reactions for
   * @returns Number of reactions synced
   *
   * @example
   * ```ts
   * const count = await service.backfillToRoomy([123n, 456n]);
   * ```
   */
  async backfillToRoomy(channelIds: bigint[]): Promise<number> {
    let syncedCount = 0;

    for (const channelId of channelIds) {
      const channelKey = getRoomKey(channelId);
      const roomyRoomId = await this.repo.getRoomyId(channelKey);

      if (!roomyRoomId) {
        console.warn(
          `[ReactionSyncService] Channel ${channelId} not synced to Roomy, skipping reaction backfill`,
        );
        continue;
      }

      // Fetch messages with pagination to get their reactions
      let before: bigint | undefined;
      while (true) {
        const messages = await this.bot.helpers.getMessages(channelId, {
          before,
          limit: 100,
        });

        if (messages.length === 0) break;

        // Process each message's reactions
        for (const message of messages) {
          const reactions = (message as unknown as { reactions?: unknown[] })
            .reactions;
          if (!reactions || reactions.length === 0) {
            continue;
          }

          // For each reaction type, fetch the users who reacted
          for (const reaction of reactions) {
            if (!reaction || typeof reaction !== "object") continue;

            const emoji = (reaction as { emoji?: Partial<Emoji> }).emoji;
            if (!emoji) continue;

            const count = (reaction as { count?: number }).count || 1;

            // Fetch all users who reacted with this emoji (with pagination)
            let after: string | undefined;
            let hasMore = true;

            while (hasMore) {
              // Build emoji string for API call
              let emojiString = emoji.name || "";
              if (emoji.id) {
                emojiString = `${emoji.name}:${emoji.id}`;
              }

              const options: { limit: number; after?: string } = { limit: 100 };
              if (after) {
                options.after = after;
              }

              const users = await this.bot.helpers.getReactions(
                channelId,
                message.id,
                emojiString,
                options as any,
              );

              if (users.length === 0) {
                hasMore = false;
                break;
              }

              // Sync each user's reaction to Roomy
              for (const user of users) {
                const reactionEventId = await this.syncAddToRoomy(
                  message.id,
                  channelId,
                  user.id,
                  emoji,
                );

                if (reactionEventId) {
                  syncedCount++;
                }
              }

              // Check if there are more users to fetch
              if (users.length < 100) {
                hasMore = false;
              } else {
                after = users[users.length - 1]?.id?.toString();
              }
            }
          }

          // Update cursor for message pagination
          before = message.id;
        }

        if (messages.length < 100) break;
      }
    }

    console.log(
      `[ReactionSyncService] Backfilled ${syncedCount} reactions to Roomy`,
    );

    return syncedCount;
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
   */
  async syncRoomyToDiscordAdd(
    roomyMessageId: Ulid,
    roomyRoomId: Ulid,
    reaction: string,
    userDid: Did,
  ): Promise<void> {
    // Get Discord message ID
    const discordId = await this.repo.getDiscordId(roomyMessageId);
    if (!discordId) {
      console.warn(
        `[ReactionSyncService] Roomy message ${roomyMessageId} not synced to Discord, skipping reaction`,
      );
      return;
    }

    const messageId = BigInt(discordId.replace("room:", ""));

    // Get Discord channel ID
    const discordChannelId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordChannelId) {
      console.warn(
        `[ReactionSyncService] Room ${roomyRoomId} not synced to Discord, skipping reaction`,
      );
      return;
    }

    const channelId = BigInt(discordChannelId.replace("room:", ""));

    // Parse user DID to get Discord user ID
    // Format: did:discord:123456789
    const userIdMatch = userDid.match(/^did:discord:(\d+)$/);
    if (!userIdMatch) {
      console.warn(
        `[ReactionSyncService] Cannot map user DID ${userDid} to Discord user, skipping reaction`,
      );
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

      await this.bot.helpers.addReaction(channelId, messageId, emojiString);

      // Track the synced reaction
      await this.repo.setReaction(key, newUlid());

      console.log(
        `[ReactionSyncService] Added reaction ${reaction} to Discord message ${messageId}`,
      );
    } catch (error) {
      console.error(
        `[ReactionSyncService] Error adding reaction to Discord:`,
        error,
      );
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
  ): Promise<void> {
    // Parse user DID to get Discord user ID
    const userIdMatch = userDid.match(/^did:discord:(\d+)$/);
    if (!userIdMatch) {
      console.warn(
        `[ReactionSyncService] Cannot map user DID ${userDid} to Discord user, skipping reaction removal`,
      );
      return;
    }

    const userId = BigInt(userIdMatch[1]!);

    // Get Discord channel ID
    const discordChannelId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordChannelId) {
      console.warn(
        `[ReactionSyncService] Room ${roomyRoomId} not synced to Discord, skipping reaction removal`,
      );
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
    console.warn(
      `[ReactionSyncService] Cannot remove Discord reaction for Roomy event ${reactionEventId} - mapping not implemented`,
    );

    // TODO: Implement proper reverse lookup for reaction removal
    // We'd need to:
    // 1. Store Roomy reaction event ID -> Discord reaction key mapping
    // 2. Query that mapping here
    // 3. Parse the emoji and user from the key
    // 4. Call bot.helpers.deleteOwnReaction() or bot.helpers.deleteUserReaction()
  }

  /**
   * Handle a Roomy event from the subscription stream.
   * Processes reaction-related events and syncs them to Discord if needed.
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
      const e = event as any;

      // Check for Discord origin
      const reactionOrigin = extractDiscordReactionOrigin(event);
      if (reactionOrigin) {
        if (isLastEvent)
          this.dispatcher.toDiscord.push({ batchId, isLastEvent });
        return true;
      } // Handled (Discord origin, no sync back)
      this.dispatcher.toDiscord.push({ decoded, batchId, isLastEvent });
      return true;
    } catch (error) {
      console.error(`[ReactionSyncService] Error handling Roomy event:`, error);
      return false;
    }
  }

  /**
   * Sync Roomy-origin reaction events to Discord.
   * Called by dispatcher.syncRoomyToDiscord consumer loop.
   */
  async syncToDiscord(decoded: DecodedStreamEvent): Promise<void> {
    const { event: e } = decoded;

    // Handle addReaction
    if (
      e.$type === "space.roomy.reaction.addReaction.v0" ||
      e.$type === "space.roomy.reaction.addBridgedReaction.v0"
    ) {
      await this.syncRoomyToDiscordAdd(
        e.reactionTo,
        e.room,
        e.reaction,
        decoded.user,
      );
    }
    // Handle removeReaction
    else if (
      e.$type === "space.roomy.reaction.removeReaction.v0" ||
      e.$type === "space.roomy.reaction.removeBridgedReaction.v0"
    ) {
      if (!e.room) return;
      if (!this.bot) return;
      await this.syncRoomyToDiscordRemove(e.id, e.room, decoded.user);
    }
  }
}
