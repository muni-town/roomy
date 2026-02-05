/**
 * Service for syncing messages between Discord and Roomy.
 * Bidirectional sync (create, edit, delete operations).
 *
 * This service handles message synchronization with idempotency tracking.
 * Depends on ProfileSyncService for user profile syncing.
 */

import { avatarUrl } from "@discordeno/bot";
import type { BridgeRepository } from "../repositories/index.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { newUlid, toBytes, type Did, type Event, type Ulid, type Attachment } from "@roomy/sdk";
import type { DiscordBot, MessageProperties } from "../discord/types.js";
import { ProfileSyncService } from "./ProfileSyncService.js";
import { DISCORD_EXTENSION_KEYS } from "../roomy/subscription.js";
import { DISCORD_MESSAGE_TYPES } from "../constants.js";
import { computeEditHash } from "../utils/hash.js";

/**
 * Result of a Discord → Roomy message sync operation.
 */
export type DiscordToRoomyResult =
  | { success: true; messageId: string }
  | { success: false; reason: "already_synced" | "skipped" };

/**
 * Optional batcher for bulk operations.
 */
export interface EventBatcher {
  add(event: Event): Promise<void>;
}

/**
 * Service for syncing messages between Discord and Roomy.
 */
export class MessageSyncService {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly connectedSpace: ConnectedSpace,
    private readonly guildId: bigint,
    private readonly spaceId: string,
    private readonly profileService: ProfileSyncService,
    private readonly bot?: DiscordBot,
  ) {}

  /**
   * Sync a Discord message to Roomy.
   *
   * @param roomyRoomId - Target Roomy room ID
   * @param message - Discord message to sync
   * @param batcher - Optional event batcher for bulk operations
   * @returns The Roomy message ID, or null if skipped
   *
   * @example
   * ```ts
   * const result = await service.syncDiscordToRoomy(
   *   "roomy-room-123",
   *   discordMessage
   * );
   * ```
   */
  async syncDiscordToRoomy(
    roomyRoomId: string,
    message: MessageProperties,
    batcher?: EventBatcher,
  ): Promise<string | null> {
    // Idempotency check
    const existingId = await this.repo.getRoomyId(message.id.toString());
    if (existingId) {
      return existingId;
    }

    // Check if message should be skipped (before profile sync to avoid unnecessary work)
    if (await this.shouldSkipMessage(message)) {
      return null;
    }

    // Ensure user profile is synced
    await this.profileService.syncDiscordToRoomy({
      id: message.author.id,
      username: message.author.username,
      discriminator: message.author.discriminator,
      globalName: (message.author as any).globalName ?? null,
      avatar: (message.author.avatar as unknown as string | null) ?? null,
    }, batcher);

    // Handle thread starter messages
    if (message.type === DISCORD_MESSAGE_TYPES.THREAD_STARTER_MESSAGE) {
      return await this.handleThreadStarterMessage(roomyRoomId, message, batcher);
    }

    // Build attachments array
    const attachments = await this.buildAttachments(message);

    // Create and send the message event
    const messageId = await this.createAndSendMessage(
      roomyRoomId,
      message,
      attachments,
      batcher,
    );

    // Register the mapping
    await this.repo.registerMapping(message.id.toString(), messageId);

    return messageId;
  }

  /**
   * Sync a Discord message edit to Roomy.
   *
   * @param message - Edited Discord message
   *
   * @example
   * ```ts
   * await service.syncEditToRoomy(editedDiscordMessage);
   * ```
   */
  async syncEditToRoomy(message: MessageProperties): Promise<void> {
    const snowflake = message.id.toString();

    // Get the Roomy message ID from our mapping
    const roomyMessageId = await this.repo.getRoomyId(snowflake);
    if (!roomyMessageId) {
      return; // Message wasn't synced originally
    }

    // Get the Roomy room ID from the Discord channel ID
    const roomKey = `room:${message.channelId.toString()}`;
    const roomyRoomId = await this.repo.getRoomyId(roomKey);
    if (!roomyRoomId) {
      return; // Channel/room wasn't synced
    }

    const editedTimestamp = message.editedTimestamp
      ? new Date(message.editedTimestamp).getTime()
      : Date.now();
    const contentHash = computeEditHash(message.content, message.attachments || []);

    // Get edit tracking info for idempotency
    const existingEdit = await this.repo.getEditInfo(snowflake);
    if (existingEdit) {
      if (editedTimestamp < existingEdit.editedTimestamp) {
        return; // Stale edit
      }
      if (
        editedTimestamp === existingEdit.editedTimestamp &&
        contentHash === existingEdit.contentHash
      ) {
        return; // Duplicate
      }
    }

    // Build extensions
    const extensions: Record<string, unknown> = {
      [DISCORD_EXTENSION_KEYS.MESSAGE_ORIGIN]: {
        $type: DISCORD_EXTENSION_KEYS.MESSAGE_ORIGIN,
        snowflake,
        channelId: message.channelId.toString(),
        guildId: this.guildId.toString(),
        editedTimestamp,
        contentHash,
      },
    };

    // Include attachments if present
    if (message.attachments && message.attachments.length > 0) {
      const attachmentArray: unknown[] = [];
      for (const att of message.attachments) {
        if (att.contentType?.startsWith("image/")) {
          attachmentArray.push({
            $type: "space.roomy.attachment.image.v0",
            uri: att.url,
            mimeType: att.contentType,
            width: att.width,
            height: att.height,
            size: att.size,
          });
        } else if (att.contentType?.startsWith("video/")) {
          attachmentArray.push({
            $type: "space.roomy.attachment.video.v0",
            uri: att.url,
            mimeType: att.contentType,
            width: att.width,
            height: att.height,
            size: att.size,
          });
        } else {
          attachmentArray.push({
            $type: "space.roomy.attachment.file.v0",
            uri: att.url,
            mimeType: att.contentType || "application/octet-stream",
            name: att.filename,
            size: att.size,
          });
        }
      }
      extensions["space.roomy.extension.attachments.v0"] = {
        $type: "space.roomy.extension.attachments.v0",
        attachments: attachmentArray,
      };
    } else {
      // Explicitly remove attachments extension
      extensions["space.roomy.extension.attachments.v0"] = null;
    }

    // Send edit event
    const event: Event = {
      id: newUlid(),
      room: roomyRoomId as Ulid,
      $type: "space.roomy.message.editMessage.v0",
      messageId: roomyMessageId as Ulid,
      body: {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(message.content)),
      },
      extensions,
    };

    await this.connectedSpace.sendEvent(event);

    // Update cache
    await this.repo.setEditInfo(snowflake, { editedTimestamp, contentHash });
  }

  /**
   * Sync a Discord message deletion to Roomy.
   *
   * @param messageId - Discord message ID to delete
   *
   * @example
   * ```ts
   * await service.syncDeleteToRoomy(123n);
   * ```
   */
  async syncDeleteToRoomy(messageId: bigint): Promise<void> {
    // Get the Roomy message ID
    const roomyMessageId = await this.repo.getRoomyId(messageId.toString());
    if (!roomyMessageId) {
      return; // Message wasn't synced
    }

    // Get the Roomy room ID
    const roomyRoomId = await this.repo.getDiscordId(roomyMessageId);
    if (!roomyRoomId) {
      return; // Can't delete without room
    }

    // Send delete event
    const event: Event = {
      id: newUlid(),
      room: roomyRoomId as Ulid,
      $type: "space.roomy.message.deleteMessage.v0",
      messageId: roomyMessageId as Ulid,
    };

    await this.connectedSpace.sendEvent(event);
  }

  /**
   * Determine if a message should be skipped.
   */
  private async shouldSkipMessage(message: MessageProperties): Promise<boolean> {
    // Skip system messages
    if (
      message.type === DISCORD_MESSAGE_TYPES.THREAD_CREATED ||
      message.type === DISCORD_MESSAGE_TYPES.CHANNEL_NAME_CHANGE
    ) {
      return true;
    }

    // Skip bot's own webhook messages (avoid echo)
    const channelWebhookToken = await this.repo.getWebhookToken(
      message.channelId.toString(),
    );
    const channelWebhookId = channelWebhookToken?.split(":")[0];
    if (channelWebhookId && message.webhookId?.toString() === channelWebhookId) {
      return true;
    }

    return false;
  }

  /**
   * Handle thread starter messages by forwarding the original message.
   */
  private async handleThreadStarterMessage(
    roomyRoomId: string,
    message: MessageProperties,
    batcher?: EventBatcher,
  ): Promise<string | null> {
    if (!message.messageReference?.messageId) {
      return null;
    }

    const originalMsgIdStr = message.messageReference.messageId.toString();
    let originalRoomyId = await this.repo.getRoomyId(originalMsgIdStr);

    // If original message not synced, fetch it from Discord
    if (!originalRoomyId) {
      if (!this.bot) {
        return null;
      }

      try {
        const originalMsg = await this.bot.helpers.getMessage(
          message.messageReference.channelId!,
          message.messageReference.messageId,
        );

        const parentChannelKey = `room:${message.messageReference.channelId!.toString()}`;
        const parentRoomyId = await this.repo.getRoomyId(parentChannelKey);
        if (!parentRoomyId) {
          return null;
        }

        const syncedId = await this.syncDiscordToRoomy(parentRoomyId, originalMsg, batcher);
        if (!syncedId) {
          return null;
        }
        originalRoomyId = syncedId;
      } catch (e) {
        return null;
      }
    }

    // Get the parent channel's Roomy ID
    const parentChannelKey = `room:${message.messageReference.channelId!.toString()}`;
    const fromRoomyId = await this.repo.getRoomyId(parentChannelKey);

    if (!fromRoomyId) {
      return null;
    }

    // Forward the original message to this thread room
    const forwardEvent: Event = {
      id: newUlid(),
      room: roomyRoomId as Ulid,
      $type: "space.roomy.message.forwardMessages.v0",
      messageIds: [originalRoomyId as Ulid],
      fromRoomId: fromRoomyId as Ulid,
    };

    const sendFn = batcher ? batcher.add.bind(batcher) : this.connectedSpace.sendEvent.bind(this.connectedSpace);
    await sendFn(forwardEvent);

    await this.repo.registerMapping(message.id.toString(), forwardEvent.id);

    return forwardEvent.id;
  }

  /**
   * Build the attachments array for a message.
   */
  private async buildAttachments(message: MessageProperties): Promise<Attachment[]> {
    const attachments: Attachment[] = [];

    // Reply attachment
    if (message.messageReference?.messageId) {
      const targetIdStr = message.messageReference.messageId.toString();
      const replyTargetId = await this.repo.getRoomyId(targetIdStr);
      if (replyTargetId) {
        attachments.push({
          $type: "space.roomy.attachment.reply.v0",
          target: replyTargetId as Ulid,
        });
      }
    }

    // Media attachments
    for (const att of message.attachments || []) {
      if (att.contentType?.startsWith("image/")) {
        attachments.push({
          $type: "space.roomy.attachment.image.v0",
          uri: att.url,
          mimeType: att.contentType,
          width: att.width,
          height: att.height,
          size: att.size,
        });
      } else if (att.contentType?.startsWith("video/")) {
        attachments.push({
          $type: "space.roomy.attachment.video.v0",
          uri: att.url,
          mimeType: att.contentType,
          width: att.width,
          height: att.height,
          size: att.size,
        });
      } else {
        attachments.push({
          $type: "space.roomy.attachment.file.v0",
          uri: att.url,
          mimeType: att.contentType || "application/octet-stream",
          name: att.filename,
          size: att.size,
        });
      }
    }

    return attachments;
  }

  /**
   * Create and send the Roomy message event.
   */
  private async createAndSendMessage(
    roomyRoomId: string,
    message: MessageProperties,
    attachments: Attachment[],
    batcher?: EventBatcher,
  ): Promise<string> {
    const messageId = newUlid();

    const extensions: Record<string, unknown> = {
      [DISCORD_EXTENSION_KEYS.MESSAGE_ORIGIN]: {
        $type: DISCORD_EXTENSION_KEYS.MESSAGE_ORIGIN,
        snowflake: message.id.toString(),
        channelId: message.channelId.toString(),
        guildId: this.guildId.toString(),
      },
      "space.roomy.extension.authorOverride.v0": {
        $type: "space.roomy.extension.authorOverride.v0",
        did: `did:discord:${message.author.id}` as Did,
      },
      "space.roomy.extension.timestampOverride.v0": {
        $type: "space.roomy.extension.timestampOverride.v0",
        timestamp: new Date(message.timestamp).getTime(),
      },
    };

    if (attachments.length > 0) {
      extensions["space.roomy.extension.attachments.v0"] = {
        $type: "space.roomy.extension.attachments.v0",
        attachments,
      };
    }

    const event: Event = {
      id: messageId,
      room: roomyRoomId as Ulid,
      $type: "space.roomy.message.createMessage.v0",
      body: {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(message.content)),
      },
      extensions,
    };

    const sendFn = batcher ? batcher.add.bind(batcher) : this.connectedSpace.sendEvent.bind(this.connectedSpace);
    await sendFn(event);

    return messageId;
  }
}
