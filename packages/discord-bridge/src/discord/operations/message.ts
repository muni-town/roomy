/**
 * Message operations for Discord.
 * High-level functions for creating, editing, and deleting messages.
 */

import type { DiscordBot, DiscordMessageOptions } from "../types.js";

/**
 * Options for creating a message via webhook.
 */
export interface CreateWebhookMessageOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Webhook ID to use */
  webhookId: bigint;
  /** Webhook token for authentication */
  webhookToken: string;
  /** Message content */
  content: string;
  /** Override username (optional) */
  username?: string;
  /** Override avatar URL (optional) */
  avatarUrl?: string;
  /** Nonce for idempotency (optional) */
  nonce?: string;
}

/**
 * Result of creating a message.
 */
export interface CreateMessageResult {
  /** Discord message snowflake */
  id: bigint;
}

/**
 * Create a message via webhook (for impersonated messages).
 *
 * @param bot - Discord bot instance
 * @param options - Message creation options
 * @returns The created message ID
 *
 * @example
 * ```ts
 * const result = await createWebhookMessage(bot, {
 *   channelId: 123456789n,
 *   webhookId: 987654321n,
 *   webhookToken: "abc123",
 *   content: "Hello from webhook!",
 *   username: "Custom Bot",
 * });
 * ```
 */
export async function createWebhookMessage(
  bot: DiscordBot,
  options: CreateWebhookMessageOptions,
): Promise<CreateMessageResult> {
  // Pass wait=true in the options to get the message object back from Discord
  const messageOptions: DiscordMessageOptions = {
    content: options.content,
    ...(options.username && { username: options.username }),
    ...(options.avatarUrl && { avatarUrl: options.avatarUrl }),
    ...(options.nonce && { nonce: options.nonce }),
    wait: true,
  } as any;

  const result = await bot.helpers.executeWebhook(
    options.webhookId,
    options.webhookToken,
    messageOptions,
  );

  if (!result?.id) {
    throw new Error("Webhook execution did not return a message ID");
  }

  return { id: result.id };
}

/**
 * Options for creating a message as the bot.
 */
export interface CreateBotMessageOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Message content */
  content: string;
}

/**
 * Create a message as the bot (not impersonated).
 *
 * @param bot - Discord bot instance
 * @param options - Message creation options
 * @returns The created message ID
 *
 * @example
 * ```ts
 * const result = await createBotMessage(bot, {
 *   channelId: 123456789n,
 *   content: "Hello from bot!",
 * });
 * ```
 */
export async function createBotMessage(
  bot: DiscordBot,
  options: CreateBotMessageOptions,
): Promise<CreateMessageResult> {
  const result = await bot.helpers.sendMessage(options.channelId, {
    content: options.content,
  });

  return { id: result.id };
}

/**
 * Options for editing a message.
 */
export interface EditMessageOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Discord message ID to edit */
  messageId: bigint;
  /** New message content */
  content: string;
}

/**
 * Result of editing a message.
 */
export interface EditMessageResult {
  /** Discord message snowflake */
  id: bigint;
}

/**
 * Edit a message.
 *
 * @param bot - Discord bot instance
 * @param options - Message edit options
 * @returns The edited message ID
 *
 * @example
 * ```ts
 * const result = await editMessage(bot, {
 *   channelId: 123456789n,
 *   messageId: 987654321n,
 *   content: "Edited message",
 * });
 * ```
 */
export async function editMessage(
  bot: DiscordBot,
  options: EditMessageOptions,
): Promise<EditMessageResult> {
  const result = await bot.helpers.editMessage(
    options.channelId,
    options.messageId,
    { content: options.content },
  );

  return { id: result.id };
}

/**
 * Options for deleting a message.
 */
export interface DeleteMessageOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Discord message ID to delete */
  messageId: bigint;
}

/**
 * Result of deleting a message.
 */
export interface DeleteMessageResult {
  success: true;
}

/**
 * Delete a message.
 *
 * @param bot - Discord bot instance
 * @param options - Message delete options
 * @returns Success indicator
 *
 * @example
 * ```ts
 * await deleteMessage(bot, {
 *   channelId: 123456789n,
 *   messageId: 987654321n,
 * });
 * ```
 */
export async function deleteMessage(
  bot: DiscordBot,
  options: DeleteMessageOptions,
): Promise<DeleteMessageResult> {
  await bot.helpers.deleteMessage(options.channelId, options.messageId);
  return { success: true };
}

/**
 * Options for fetching a message.
 */
export interface FetchMessageOptions {
  /** Discord channel ID */
  channelId: bigint;
  /** Discord message ID to fetch */
  messageId: bigint;
}

/**
 * Result of fetching a message.
 */
export interface FetchMessageResult {
  id: bigint;
  content: string;
  author: {
    id: bigint;
    username: string;
    discriminator: string;
    avatar?: string | null;
  };
  timestamp: number;
  editedTimestamp?: number | null;
  attachments: Array<{
    id: bigint;
    filename: string;
    contentType?: string;
    size: number;
    url: string;
    width?: number;
    height?: number;
  }>;
  webhookId?: bigint;
  type: number;
  messageReference?: {
    messageId?: bigint;
    channelId?: bigint;
    guildId?: bigint;
  } | null;
}

/**
 * Fetch a message from Discord.
 *
 * @param bot - Discord bot instance
 * @param options - Message fetch options
 * @returns The fetched message
 *
 * @example
 * ```ts
 * const message = await fetchMessage(bot, {
 *   channelId: 123456789n,
 *   messageId: 987654321n,
 * });
 * ```
 */
export async function fetchMessage(
  bot: DiscordBot,
  options: FetchMessageOptions,
): Promise<FetchMessageResult> {
  const message = await bot.helpers.getMessage(
    options.channelId,
    options.messageId,
  );

  return {
    id: message.id,
    content: message.content || "",
    author: {
      id: message.author.id,
      username: message.username,
      discriminator: message.discriminator,
      avatar: message.avatar as unknown as string | null,
    },
    timestamp: Number(message.timestamp),
    editedTimestamp: message.editedTimestamp
      ? Number(message.editedTimestamp)
      : null,
    attachments: message.attachments?.map((att) => ({
      id: att.id,
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      url: att.url,
      width: att.width,
      height: att.height,
    })) || [],
    webhookId: message.webhookId,
    type: message.type,
    messageReference: message.messageReference
      ? {
          messageId: message.messageReference.messageId,
          channelId: message.messageReference.channelId,
          guildId: message.messageReference.guildId,
        }
      : null,
  };
}
