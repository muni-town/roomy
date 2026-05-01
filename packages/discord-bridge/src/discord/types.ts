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
  createDesiredPropertiesObject,
} from "@discordeno/bot";

export const desiredProperties = createDesiredPropertiesObject({
  message: {
    id: true,
    guildId: true,
    content: true,
    channelId: true,
    author: true,
    webhookId: true,
    editedTimestamp: true,
    attachments: true,
    messageReference: true,
    type: true,
    reactions: true,
    stickerItems: true,
  },
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
  },
  user: {
    username: true,
    avatar: true,
    id: true,
    discriminator: true,
    globalName: true,
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
} satisfies RecursivePartial<TransformersDesiredProperties>);

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

export type DiscordBot = Bot<
  CompleteDesiredProperties<typeof desiredProperties>
>;
