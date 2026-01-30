import {
  Bot,
  Channel,
  CompleteDesiredProperties,
  Message,
  RecursivePartial,
  SetupDesiredProps,
  TransformersDesiredProperties,
} from "@discordeno/bot";

const messageProperties = {
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
} as const;
export type MessageProperties = SetupDesiredProps<
  Message,
  CompleteDesiredProperties<typeof desiredProperties>
>;

const channelProperties = {
  id: true,
  lastMessageId: true,
  name: true,
  type: true,
  guildId: true,
  parentId: true,
} as const;
export type ChannelProperties = SetupDesiredProps<
  Channel,
  CompleteDesiredProperties<typeof desiredProperties>
>;

export const desiredProperties = {
  message: messageProperties,
  guild: {
    id: true,
    channels: true,
  },
  channel: channelProperties,
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
