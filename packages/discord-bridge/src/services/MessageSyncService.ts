/**
 * Service for syncing messages between Discord and Roomy.
 * Bidirectional sync (create, edit, delete operations).
 *
 * This service handles message synchronization with idempotency tracking.
 * Depends on ProfileSyncService for user profile syncing.
 */

import { avatarUrl } from "@discordeno/bot";
import type { BridgeRepository } from "../repositories/index.js";
import type { ConnectedSpace, StreamDid, StateMachine } from "@roomy/sdk";
import {
  newUlid,
  toBytes,
  type Did,
  type Event,
  type Ulid,
  type Attachment,
  type Content,
  type DecodedStreamEvent,
} from "@roomy/sdk";
import type { DiscordBot, MessageProperties } from "../discord/types.js";
import { ProfileSyncService } from "./ProfileSyncService.js";
import {
  DISCORD_EXTENSION_KEYS,
  extractDiscordMessageOrigin,
} from "../utils/event-extensions.js";
import { DISCORD_MESSAGE_TYPES } from "../constants.js";
import { computeEditHash } from "../utils/hash.js";
import {
  getOrCreateWebhook,
  executeWebhookWithRetry,
} from "../discord/webhooks.js";
import { getRoomKey } from "../utils/room.js";
import type { EventDispatcher } from "../dispatcher.js";

/**
 * Result of a Discord → Roomy message sync operation.
 */
export type DiscordToRoomyResult =
  | { success: true; messageId: string }
  | { success: false; reason: "already_synced" | "skipped" };

/**
 * Service for syncing messages between Discord and Roomy.
 */
export class MessageSyncService {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly spaceId: StreamDid,
    private readonly dispatcher: EventDispatcher,
    private readonly guildId: bigint,
    private readonly profileService: ProfileSyncService,
    private readonly bot: DiscordBot,
  ) {}

  /**
   * Sync a Discord message to Roomy.
   *
   * @param message - Discord message to sync
   * @returns The Roomy message ID, or null if skipped
   *
   * @example
   * ```ts
   * const result = await service.syncDiscordToRoomy(discordMessage);
   * ```
   */
  async syncDiscordToRoomy(message: MessageProperties): Promise<string | null> {
    // Check that we know the corresponding Roomy room
    const roomyRoomId = await this.repo.getRoomyId(
      getRoomKey(message.channelId),
    );
    if (!roomyRoomId) {
      console.warn(
        `Discord channel ${message.channelId} not synced to Roomy, skipping message`,
      );
      return null;
    }

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
    });

    // Handle thread starter messages
    if (message.type === DISCORD_MESSAGE_TYPES.THREAD_STARTER_MESSAGE) {
      return await this.handleThreadStarterMessage(roomyRoomId, message);
    }

    // Build attachments array
    const attachments = await this.buildAttachments(message);

    // Create and send the message event
    const messageId = await this.createAndSendMessage(
      roomyRoomId,
      message,
      attachments,
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
    // Skip if not a user edit (embed resolution, pin change, etc.)
    if (!message.editedTimestamp) return;

    const snowflake = message.id.toString();

    // Get the Roomy message ID from our mapping
    const roomyMessageId = await this.repo.getRoomyId(snowflake);
    if (!roomyMessageId) {
      return; // Message wasn't synced originally
    }

    // Get the Roomy room ID from the Discord channel ID
    const roomyRoomId = await this.repo.getRoomyId(
      getRoomKey(message.channelId),
    );
    if (!roomyRoomId) {
      console.warn(
        `Discord channel ${message.channelId} not synced to Roomy, skipping message`,
      );
      return; // Channel/room wasn't synced
    }

    const editedTimestamp = message.editedTimestamp
      ? new Date(message.editedTimestamp).getTime()
      : Date.now();
    const contentHash = computeEditHash(
      message.content,
      message.attachments || [],
    );

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

    this.dispatcher.toRoomy.push(event);

    // Update cache
    await this.repo.setEditInfo(snowflake, { editedTimestamp, contentHash });
  }

  /**
   * Sync a Discord message deletion to Roomy.
   *
   * @param messageId - Discord message ID to delete
   * @param channelId - Discord channel ID containing the message
   *
   * @example
   * ```ts
   * await service.syncDeleteToRoomy(123n, 456n);
   * ```
   */
  async syncDeleteToRoomy(messageId: bigint, channelId: bigint): Promise<void> {
    // Get the Roomy message ID
    const roomyMessageId = await this.repo.getRoomyId(messageId.toString());
    if (!roomyMessageId) {
      return; // Message wasn't synced
    }

    // Get the Roomy room ID from the Discord channel ID
    const roomKey = `room:${channelId.toString()}`;
    const roomyRoomId = await this.repo.getRoomyId(roomKey);
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

    this.dispatcher.toRoomy.push(event);
  }

  /**
   * Determine if a message should be skipped.
   */
  private async shouldSkipMessage(
    message: MessageProperties,
  ): Promise<boolean> {
    // Skip system messages
    if (
      message.type === DISCORD_MESSAGE_TYPES.THREAD_CREATED ||
      message.type === DISCORD_MESSAGE_TYPES.CHANNEL_NAME_CHANGE
    ) {
      return true;
    }

    // Check if this channel has webhook setup (indicates Roomy → Discord sync is active)
    const channelWebhookToken = await this.repo.getWebhookToken(
      message.channelId.toString(),
    );
    const channelWebhookId = channelWebhookToken?.split(":")[0];

    // Skip bot's own webhook messages (avoid echo)
    if (
      channelWebhookId &&
      message.webhookId?.toString() === channelWebhookId
    ) {
      return true;
    }

    // Skip bot's own regular messages ONLY when webhook is configured for the channel
    // This prevents echo loops when Roomy → Discord sync is active
    // When no webhook is configured, we allow bot messages (for testing and initial sync)
    if (this.bot && channelWebhookId && message.author.id === this.bot.id) {
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
  ): Promise<string | null> {
    if (
      !message.messageReference?.messageId ||
      !message.messageReference.channelId
    ) {
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

        const syncedId = await this.syncDiscordToRoomy(originalMsg);
        if (!syncedId) {
          return null;
        }
        originalRoomyId = syncedId;
      } catch (e) {
        return null;
      }
    }

    // Get the parent channel's Roomy ID
    const fromRoomyId = await this.repo.getRoomyId(
      getRoomKey(message.messageReference.channelId),
    );

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

    this.dispatcher.toRoomy.push(forwardEvent);

    await this.repo.registerMapping(message.id.toString(), forwardEvent.id);

    return forwardEvent.id;
  }

  /**
   * Build the attachments array for a message.
   */
  private async buildAttachments(
    message: MessageProperties,
  ): Promise<Attachment[]> {
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
        timestamp: message.timestamp
          ? new Date(message.timestamp as unknown as string).getTime()
          : Date.now(),
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

    this.dispatcher.toRoomy.push(event);

    return messageId;
  }

  /**
   * Backfill Discord messages to Roomy for specified channels.
   * Fetches all messages and syncs them using dispatcher batching.
   *
   * @param channelIds - Discord channel IDs to backfill
   * @returns Number of messages synced
   *
   * @example
   * ```ts
   * const count = await service.backfillToRoomy([123n, 456n]);
   * ```
   */
  async backfillToRoomy(channelIds: bigint[]): Promise<number> {
    let syncedCount = 0;
    let skippedCount = 0;

    for (const channelId of channelIds) {
      const channelKey = getRoomKey(channelId);
      const roomyRoomId = await this.repo.getRoomyId(channelKey);

      if (!roomyRoomId) {
        console.warn(
          `[MessageSyncService] Channel ${channelId} not synced to Roomy, skipping backfill`,
        );
        continue;
      }

      // Fetch messages with pagination (oldest first)
      let before: bigint | undefined;
      while (true) {
        const messages = await this.bot.helpers.getMessages(channelId, {
          before,
          limit: 100,
        });

        if (messages.length === 0) break;

        // Process oldest first (API returns newest first)
        const sortedMessages = [...messages].reverse();
        for (const message of sortedMessages) {
          const messageIdStr = message.id.toString();

          // Idempotency check
          const existingId = await this.repo.getRoomyId(messageIdStr);
          if (existingId) {
            skippedCount++;
            continue;
          }

          // Sync the message
          const result = await this.syncDiscordToRoomy(message);
          if (result) {
            syncedCount++;
          }
        }

        // Update cursor
        before = messages[0]?.id;
      }
    }

    console.log(
      `[MessageSyncService] Backfilled ${syncedCount} messages to Roomy, skipped ${skippedCount} already synced`,
    );

    return syncedCount;
  }

  // ============================================================
  // ROOMY → DISCORD sync methods
  // ============================================================

  /**
   * Sync a Roomy message create to Discord.
   *
   * @param roomyMessageId - Roomy message ULID
   * @param roomyRoomId - Roomy room ULID
   * @param content - Message content (mimeType + data)
   * @param authorDid - Author DID (for username lookup)
   * @param bot - Discord bot instance
   * @returns Discord message ID, or null if skipped
   */
  async syncRoomyToDiscordCreate(
    roomyMessageId: string,
    roomyRoomId: string,
    content: { mimeType: string; data: { buf: Uint8Array } },
    authorDid: Did,
    bot: DiscordBot,
  ): Promise<bigint | null> {
    // Idempotency check - already synced?
    const existingDiscordId = await this.repo.getDiscordId(roomyMessageId);
    if (existingDiscordId) {
      return BigInt(existingDiscordId.replace("room:", ""));
    }

    // Get Discord channel ID for this Roomy room
    const discordId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordId) {
      console.warn(
        `[MessageSyncService] Room ${roomyRoomId} not synced to Discord, skipping message`,
      );
      return null;
    }

    const channelId = BigInt(discordId.replace("room:", ""));

    // Decode content
    const contentBytes = content.data as { buf: Uint8Array };
    const contentText = new TextDecoder().decode(contentBytes.buf);

    // Parse author DID to get Discord user ID
    // Format: did:discord:123456789
    const userIdMatch = authorDid.match(/^did:discord:(\d+)$/);
    const username = userIdMatch ? `User ${userIdMatch[1]}` : "Roomy User";

    try {
      // Get or create webhook for this channel
      const webhook = await getOrCreateWebhook(
        bot,
        this.guildId,
        this.spaceId,
        channelId,
        this.repo,
      );

      // Execute webhook to send message
      // wait: true ensures Discord returns the message object
      const result = await executeWebhookWithRetry(
        bot,
        webhook.id,
        webhook.token,
        {
          content: contentText,
          username,
          wait: true,
        } as any,
      );

      if (!result?.id) {
        console.error(
          `[MessageSyncService] Webhook execute failed, no message ID returned`,
        );
        return null;
      }

      // Register mapping (no "room:" prefix for messages)
      await this.repo.registerMapping(result.id.toString(), roomyMessageId);

      console.log(
        `[MessageSyncService] Synced Roomy message ${roomyMessageId} to Discord ${result.id}`,
      );

      return result.id;
    } catch (error) {
      console.error(
        `[MessageSyncService] Error syncing Roomy message to Discord:`,
        error,
      );
      return null;
    }
  }

  /**
   * Sync a Roomy message edit to Discord.
   *
   * @param roomyMessageId - Roomy message ULID
   * @param roomyRoomId - Roomy room ULID
   * @param content - New message content (mimeType + data)
   * @param bot - Discord bot instance
   */
  async syncRoomyToDiscordEdit(
    roomyMessageId: string,
    roomyRoomId: string,
    content: { mimeType: string; data: { buf: Uint8Array } },
    bot: DiscordBot,
  ): Promise<void> {
    // Get Discord message ID
    const discordId = await this.repo.getDiscordId(roomyMessageId);
    if (!discordId) {
      console.warn(
        `[MessageSyncService] Roomy message ${roomyMessageId} not synced to Discord, skipping edit`,
      );
      return;
    }

    const messageId = discordId.replace("room:", "");

    // Get Discord channel ID
    const discordChannelId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordChannelId) {
      console.warn(
        `[MessageSyncService] Room ${roomyRoomId} not synced to Discord, skipping edit`,
      );
      return;
    }

    const channelId = BigInt(discordChannelId.replace("room:", ""));

    // Decode content
    const contentBytes = content.data as { buf: Uint8Array };
    const contentText = new TextDecoder().decode(contentBytes.buf);

    try {
      // Messages created by webhooks must be edited by webhooks
      // Get the webhook for this channel
      const webhook = await getOrCreateWebhook(
        bot,
        this.guildId,
        this.spaceId,
        channelId,
        this.repo,
      );

      // Use webhook to edit the message
      await bot.helpers.editWebhookMessage(
        BigInt(webhook.id),
        webhook.token,
        BigInt(messageId),
        {
          content: contentText,
        },
      );

      console.log(
        `[MessageSyncService] Edited Discord message ${messageId} from Roomy ${roomyMessageId}`,
      );
    } catch (error) {
      console.error(
        `[MessageSyncService] Error editing Discord message:`,
        error,
      );
    }
  }

  /**
   * Sync a Roomy message delete to Discord.
   *
   * @param roomyMessageId - Roomy message ULID
   * @param roomyRoomId - Roomy room ULID
   * @param bot - Discord bot instance
   */
  async syncRoomyToDiscordDelete(
    roomyMessageId: string,
    roomyRoomId: string,
    bot: DiscordBot,
  ): Promise<void> {
    // Get Discord message ID
    const discordId = await this.repo.getDiscordId(roomyMessageId);
    if (!discordId) {
      console.warn(
        `[MessageSyncService] Roomy message ${roomyMessageId} not synced to Discord, skipping delete`,
      );
      return;
    }

    const messageId = discordId.replace("room:", "");

    // Get Discord channel ID from the Roomy room ID
    const discordChannelId = await this.repo.getDiscordId(roomyRoomId);
    if (!discordChannelId) {
      console.warn(
        `[MessageSyncService] Room ${roomyRoomId} not synced to Discord, skipping delete`,
      );
      return;
    }

    const channelId = BigInt(discordChannelId.replace("room:", ""));

    try {
      // Messages created by webhooks must be deleted by webhooks
      // Get the webhook for this channel
      const webhook = await getOrCreateWebhook(
        bot,
        this.guildId,
        this.spaceId,
        channelId,
        this.repo,
      );

      // Use webhook to delete the message
      await bot.helpers.deleteWebhookMessage(
        BigInt(webhook.id),
        webhook.token,
        BigInt(messageId),
      );

      console.log(
        `[MessageSyncService] Deleted Discord message ${messageId} from Roomy ${roomyMessageId}`,
      );
    } catch (error) {
      console.error(
        `[MessageSyncService] Error deleting Discord message:`,
        error,
      );
    }
  }

  /**
   * Handle a Roomy event from the subscription stream.
   * Routes Discord-origin events (register mappings, drop) and
   * queues Roomy-origin events for Discord sync (via toDiscord channel).
   *
   * @param decoded - The decoded Roomy event
   * @returns true if the event was handled, false otherwise
   */
  async handleRoomyEvent(decoded: DecodedStreamEvent): Promise<boolean> {
    try {
      const { event } = decoded;

      // Handle createMessage
      if (event.$type === "space.roomy.message.createMessage.v0") {
        console.log("handling message", event);
        const messageOrigin = extractDiscordMessageOrigin(event);

        // Discord origin: register mapping and drop
        if (messageOrigin) {
          await this.repo.registerMapping(messageOrigin.snowflake, event.id);
          return true; // Handled (Discord origin, no sync back)
        }

        // Roomy origin: queue for Discord sync
        this.dispatcher.toDiscord.push(decoded);
        console.log("pushed message to queue");
        return true;
      }

      // Handle editMessage
      if (event.$type === "space.roomy.message.editMessage.v0") {
        const messageOrigin = extractDiscordMessageOrigin(event);

        // Cache edit tracking info for Discord-origin messages
        if (messageOrigin?.editedTimestamp && messageOrigin?.contentHash) {
          await this.repo.setEditInfo(messageOrigin.snowflake, {
            editedTimestamp: messageOrigin.editedTimestamp,
            contentHash: messageOrigin.contentHash,
          });
        }

        // Discord origin: drop (already handled)
        if (messageOrigin) return true;

        // Roomy origin: queue for Discord sync
        this.dispatcher.toDiscord.push(decoded);
        return true;
      }

      // Handle deleteMessage
      if (event.$type === "space.roomy.message.deleteMessage.v0") {
        // Unregister mapping (for both Discord and Roomy origin)
        const discordId = await this.repo.getDiscordId(event.messageId);
        if (discordId) {
          await this.repo.unregisterMapping(discordId, event.messageId);
        }

        const messageOrigin = extractDiscordMessageOrigin(event);

        // Discord origin: drop
        if (messageOrigin) return true;

        // Roomy origin: queue for Discord sync
        this.dispatcher.toDiscord.push(decoded);
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[MessageSyncService] Error handling Roomy event:`, error);
      return false;
    }
  }

  /**
   * Sync Roomy-origin message events to Discord.
   * Called by dispatcher.syncRoomyToDiscord consumer loop.
   */
  async syncToDiscord(decoded: DecodedStreamEvent): Promise<void> {
    const { event } = decoded;

    // Handle createMessage
    if (event.$type === "space.roomy.message.createMessage.v0") {
      const e = event as any;
      if (!e.room || !e.body) return;
      await this.syncRoomyToDiscordCreate(
        event.id,
        e.room,
        e.body,
        decoded.user,
        this.bot,
      );
    }
    // Handle editMessage
    else if (event.$type === "space.roomy.message.editMessage.v0") {
      const e = event as any;
      if (!e.messageId || !e.room || !e.body) return;
      await this.syncRoomyToDiscordEdit(e.messageId, e.room, e.body, this.bot);
    }
    // Handle deleteMessage
    else if (event.$type === "space.roomy.message.deleteMessage.v0") {
      const e = event as any;
      if (!e.messageId) return;
      await this.syncRoomyToDiscordDelete(e.messageId, e.room || "", this.bot);
    }
  }
}
