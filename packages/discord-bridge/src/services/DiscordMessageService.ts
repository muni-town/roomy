/**
 * Service for syncing Discord messages to Roomy.
 * Extracted from to.ts for better testability and separation of concerns.
 */

import type { EventBatcher } from "../roomy/batcher.js";
import type { DiscordBot } from "../discord/types.js";
import type { ConnectedSpace } from "@roomy/sdk";
import { MessageProperties } from "../discord/types.js";
import type { GuildContext } from "../types.js";
import {
  newUlid,
  toBytes,
  type Attachment,
  type Did,
  type Event,
  type Ulid,
} from "@roomy/sdk";
import type { BridgeRepository } from "../repositories/index.js";
import {
  tracer,
  setDiscordAttrs,
  setRoomyAttrs,
  recordError,
} from "../tracing.js";
import { getRoomKey } from "../utils/room.js";
import { DISCORD_EXTENSION_KEYS } from "../roomy/subscription.js";
import { DISCORD_MESSAGE_TYPES } from "../constants.js";

/**
 * Result of a message sync operation
 */
export type SyncResult =
  | { success: true; roomId: string }
  | { success: false; reason: "already_synced" | "skipped" | "error"; existingId?: string };

/**
 * Service for syncing Discord messages to Roomy.
 * Handles message creation, thread forwarding, and attachment processing.
 */
export class DiscordMessageService {
  constructor(
    private readonly repo: BridgeRepository,
    private readonly connectedSpace: ConnectedSpace,
    private readonly guildId: bigint,
    private readonly spaceId: string,
    private readonly bot?: DiscordBot,
  ) {}

  /**
   * Sync a Discord message to Roomy.
   *
   * @param roomyRoomId - Target Roomy room ID
   * @param message - Discord message to sync
   * @param batcher - Optional event batcher for bulk operations
   * @returns The Roomy message ID, or null if skipped
   */
  async syncMessage(
    roomyRoomId: string,
    message: MessageProperties,
    batcher?: EventBatcher,
  ): Promise<string | null> {
    return tracer.startActiveSpan(
      "sync.message.discord_to_roomy",
      async (span) => {
        try {
          this.setSpanAttributes(span, roomyRoomId, message);

          // 1. Idempotency check
          const existingId = await this.repo.getRoomyId(message.id.toString());
          if (existingId) {
            span.setAttribute("sync.result", "skipped_already_synced");
            return existingId;
          }

          // 2. Ensure user profile is synced
          await this.ensureUserProfile(message, batcher);

          // 3. Check if message should be skipped
          const skipReason = await this.shouldSkipMessage(message);
          if (skipReason) {
            span.setAttribute("sync.result", skipReason);
            if (skipReason === "skipped_system_message") {
              span.setAttribute("discord.message_type", message.type);
              console.log(`Skipping system message ${message.id} (type=${message.type})`);
            }
            return null;
          }

          // 4. Handle thread starter messages (forward original)
          if (message.type === DISCORD_MESSAGE_TYPES.THREAD_STARTER_MESSAGE) {
            return await this.handleThreadStarterMessage(roomyRoomId, message, batcher, span);
          }

          // 5. Build attachments array
          const attachments = await this.buildAttachments(message);

          // 6. Create and send the message event
          const messageId = await this.createAndSendMessage(roomyRoomId, message, attachments, batcher, span);

          // 7. Register the mapping
          await this.registerMapping(message.id, messageId, span);

          span.setAttribute("sync.result", "success");
          return messageId;
        } catch (error) {
          span.setAttribute("sync.result", "error");
          recordError(span, error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Ensure the user's profile is synced to Roomy.
   */
  private async ensureUserProfile(
    message: MessageProperties,
    batcher?: EventBatcher,
  ): Promise<void> {
    await tracer.startActiveSpan("sync.user.ensure", async (userSpan) => {
      try {
        setDiscordAttrs(userSpan, { userId: message.author.id });

        // Import dynamically to avoid circular dependency
        const { ensureRoomyProfileForDiscordUser } = await import("../roomy/to.js");
        // TODO: Refactor ensureRoomyProfileForDiscordUser to also use BridgeRepository
        // For now, we need to pass a GuildContext-like object. We'll need to get the stores
        // from the repository or pass them separately.
        // This is a temporary workaround - the profile service will handle this properly.
        const { discordWebhookTokensForBridge, syncedProfilesForBridge, syncedIdsForBridge } = await import("../db.js");

        // Create the stores needed for profile sync
        const webhookTokens = discordWebhookTokensForBridge({
          discordGuildId: this.guildId,
          roomySpaceId: this.spaceId,
        });
        const syncedProfiles = syncedProfilesForBridge({
          discordGuildId: this.guildId,
          roomySpaceId: this.spaceId,
        });
        const syncedIds = syncedIdsForBridge({
          discordGuildId: this.guildId,
          roomySpaceId: this.spaceId,
        });

        // Build a minimal GuildContext for the profile sync function
        const ctx = {
          guildId: this.guildId,
          spaceId: this.spaceId,
          syncedIds,
          syncedProfiles,
          connectedSpace: this.connectedSpace,
          // Add other required properties - use empty objects for now as they're not needed for profile sync
          latestMessagesInChannel: {} as any,
          syncedReactions: {} as any,
          syncedSidebarHash: {} as any,
          syncedRoomLinks: {} as any,
          syncedEdits: {} as any,
          discordMessageHashes: {} as any,
        } as GuildContext;

        await ensureRoomyProfileForDiscordUser(
          ctx,
          {
            id: message.author.id,
            username: message.author.username,
            discriminator: message.author.discriminator,
            globalName: (message.author as any).globalName ?? null,
            avatar: (message.author.avatar as unknown as string | null) ?? null,
          },
          batcher,
        );
      } catch (error) {
        recordError(userSpan, error);
        throw error;
      } finally {
        userSpan.end();
      }
    });
  }

  /**
   * Determine if a message should be skipped.
   * Returns the skip reason or null if the message should be synced.
   */
  private async shouldSkipMessage(message: MessageProperties): Promise<string | null> {
    // Skip bot's own webhook messages (avoid echo)
    const channelWebhookToken = await this.repo.getWebhookToken(message.channelId.toString());
    const channelWebhookId = channelWebhookToken?.split(":")[0];
    if (channelWebhookId && message.webhookId?.toString() === channelWebhookId) {
      return "skipped_own_webhook";
    }

    // Skip system messages
    if (
      message.type === DISCORD_MESSAGE_TYPES.THREAD_CREATED ||
      message.type === DISCORD_MESSAGE_TYPES.CHANNEL_NAME_CHANGE
    ) {
      return "skipped_system_message";
    }

    return null;
  }

  /**
   * Handle thread starter messages by forwarding the original message to the thread.
   */
  private async handleThreadStarterMessage(
    roomyRoomId: string,
    message: MessageProperties,
    batcher: EventBatcher | undefined,
    span: any,
  ): Promise<string | null> {
    span.setAttribute("sync.result", "thread_starter_forward");
    span.setAttribute("discord.message_type", message.type);

    if (!message.messageReference?.messageId) {
      console.warn(`ThreadStarterMessage ${message.id} has no messageReference - skipping`);
      return null;
    }

    const originalMsgIdStr = message.messageReference.messageId.toString();
    let originalRoomyId = await this.repo.getRoomyId(originalMsgIdStr);

    // If original message not synced, fetch it from Discord
    if (!originalRoomyId) {
      if (!this.bot) {
        console.warn(
          `Original message ${originalMsgIdStr} for thread starter not yet synced and no bot available - skipping forward`,
        );
        return null;
      }

      console.log(`Original message ${originalMsgIdStr} not synced, fetching from Discord...`);

      try {
        const originalMsg = await this.bot.helpers.getMessage(
          message.messageReference.channelId!,
          message.messageReference.messageId,
        );

        const parentChannelKey = getRoomKey(message.messageReference.channelId!);
        const parentRoomyId = await this.repo.getRoomyId(parentChannelKey);
        if (!parentRoomyId) {
          console.warn(
            `Parent channel ${message.messageReference.channelId} not synced - cannot sync original message`,
          );
          return null;
        }

        const syncedId = await this.syncMessage(parentRoomyId, originalMsg, batcher);
        if (!syncedId) {
          console.warn(`Failed to sync original message ${originalMsgIdStr} - skipping forward`);
          return null;
        }
        originalRoomyId = syncedId;
      } catch (e) {
        console.error(`Failed to fetch original message ${originalMsgIdStr} from Discord:`, e);
        return null;
      }
    }

    // Get the parent channel's Roomy ID
    if (!message.messageReference.channelId) {
      console.warn(`ThreadStarterMessage ${message.id} has no channelReference - skipping`);
      return null;
    }

    const parentChannelKey = getRoomKey(message.messageReference.channelId);
    const fromRoomyId = await this.repo.getRoomyId(parentChannelKey);

    if (!fromRoomyId) {
      console.warn(
        `Parent channel ${message.messageReference.channelId} not yet synced - skipping forward`,
      );
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

    if (batcher) {
      await batcher.add(forwardEvent);
    } else {
      await this.connectedSpace.sendEvent(forwardEvent);
    }

    console.log(
      `Forwarded message ${originalRoomyId} from ${fromRoomyId} to thread ${roomyRoomId} (Discord thread starter ${message.id})`,
    );

    await this.repo.registerMapping(message.id.toString(), forwardEvent.id);

    return forwardEvent.id;
  }

  /**
   * Build the attachments array for a message.
   * Includes reply attachments and media attachments.
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
      } else {
        console.warn(
          `Reply target ${message.messageReference.messageId} not found for message ${message.id}. ` +
            `The reply attachment will be missing.`,
        );
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
    batcher: EventBatcher | undefined,
    parentSpan: any,
  ): Promise<string> {
    return tracer.startActiveSpan("sync.message.send", async (sendSpan) => {
      try {
        const messageId = newUlid();
        setRoomyAttrs(sendSpan, { eventId: messageId });

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

        if (batcher) {
          await batcher.add(event);
        } else {
          await this.connectedSpace.sendEvent(event);
        }

        console.log(`Created Roomy message ${messageId} for Discord message ${message.id}`);
        return messageId;
      } catch (error) {
        recordError(sendSpan, error);
        throw error;
      } finally {
        sendSpan.end();
      }
    });
  }

  /**
   * Register the Discord → Roomy message mapping.
   */
  private async registerMapping(
    discordMessageId: bigint,
    roomyMessageId: string,
    parentSpan: any,
  ): Promise<void> {
    await tracer.startActiveSpan("sync.mapping.store", async (mappingSpan) => {
      try {
        mappingSpan.setAttribute("sync.mapping.discord_id", discordMessageId.toString());
        mappingSpan.setAttribute("sync.mapping.roomy_id", roomyMessageId);

        await this.repo.registerMapping(discordMessageId.toString(), roomyMessageId);
      } catch (e) {
        if (e instanceof Error && e.message.includes("already registered")) {
          mappingSpan.setAttribute("sync.mapping.conflict", true);
          const existingRoomyId = await this.repo.getRoomyId(discordMessageId.toString());
          if (existingRoomyId) {
            console.log(
              `Message ${discordMessageId} was registered by another process as ${existingRoomyId}`,
            );
            mappingSpan.end();
            parentSpan.setAttribute("sync.result", "success");
            return;
          }
        }
        recordError(mappingSpan, e);
        throw e;
      } finally {
        mappingSpan.end();
      }
    });
  }

  /**
   * Set span attributes for tracing.
   */
  private setSpanAttributes(span: any, roomyRoomId: string, message: MessageProperties): void {
    setDiscordAttrs(span, {
      guildId: this.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
    });
    setRoomyAttrs(span, {
      spaceId: this.spaceId,
      roomId: roomyRoomId,
    });
  }
}
