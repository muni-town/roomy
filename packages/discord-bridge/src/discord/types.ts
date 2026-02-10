import {
  Bot,
  Channel,
  CompleteDesiredProperties,
  Interaction,
  Message,
  RecursivePartial,
  SetupDesiredProps,
  TransformersDesiredProperties,
  Emoji,
} from "@discordeno/bot";

export type MessageProperties = SetupDesiredProps<
  Message,
  CompleteDesiredProperties<typeof desiredProperties>
>;

export type ChannelProperties = SetupDesiredProps<
  Channel,
  CompleteDesiredProperties<typeof desiredProperties>
>;

export type InteractionProperties = SetupDesiredProps<
  Interaction,
  CompleteDesiredProperties<typeof desiredProperties>
>;

export const desiredProperties = {
  message: {
    id: true,
    guildId: true,
    content: true,
    channelId: true,
    author: true,
    webhookId: true,
    timestamp: true,
    editedTimestamp: true,
    attachments: true,
    messageReference: true,
    type: true,
    reactions: true,
  } as const,
  guild: {
    id: true,
    channels: true,
  },
  channel: {
    id: true,
    lastMessageId: true,
    name: true,
    type: true,
    guildId: true,
    parentId: true,
    topic: true,
  },
  user: {
    username: true,
    avatar: true,
    id: true,
    discriminator: true,
  },
  webhook: {
    id: true,
    token: true,
  },
  interaction: {
    id: true,
    type: true,
    data: true,
    token: true,
    guildId: true,
    authorizingIntegrationOwners: true,
  },
  attachment: {
    id: true,
    filename: true,
    contentType: true,
    size: true,
    url: true,
    proxyUrl: true,
    width: true,
    height: true,
  },
  emoji: {
    id: true,
    name: true,
  },
  messageReference: {
    messageId: true,
    channelId: true,
    guildId: true,
  },
} satisfies RecursivePartial<TransformersDesiredProperties>;

export type DiscordBot = Bot<
  CompleteDesiredProperties<typeof desiredProperties>
>;
export type DiscordChannel = SetupDesiredProps<
  Channel,
  CompleteDesiredProperties<typeof desiredProperties>
>;

/**
 * Message options for executing webhooks.
 * Based on @discordeno/bot's ExecuteWebhook options.
 */
export interface DiscordMessageOptions {
  content?: string;
  username?: string;
  avatarUrl?: string;
}

/**
 * Discord event types for unified event routing.
 * Single-property objects provide type-safe discriminated union.
 */
export type DiscordEvent =
  | { event: "MESSAGE_CREATE"; payload: MessageProperties }
  | { event: "MESSAGE_UPDATE"; payload: MessageProperties }
  | { event: "MESSAGE_DELETE"; payload: { messageId: bigint; channelId: bigint; guildId?: bigint } }
  | {
      event: "REACTION_ADD";
      payload: {
        messageId: bigint;
        channelId: bigint;
        userId: bigint;
        emoji: Partial<Emoji>;
        guildId: bigint;
      };
    }
  | {
      event: "REACTION_REMOVE";
      payload: {
        messageId: bigint;
        channelId: bigint;
        userId: bigint;
        emoji: Partial<Emoji>;
        guildId: bigint;
      };
    }
  | { event: "CHANNEL_CREATE"; payload: ChannelProperties }
  | { event: "THREAD_CREATE"; payload: ChannelProperties & { parentId: bigint } };

