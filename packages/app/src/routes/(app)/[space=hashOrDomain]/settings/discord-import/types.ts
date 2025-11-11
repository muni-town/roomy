export type DiscordMessage<
  MessageType extends "Default" | "Reply" | string = "Default",
> = {
  id: string;
  type: MessageType;
  timestamp: string;
  timestampEdited: string | null;
  callEndedTimestamp: string | null;
  isPinned: boolean;
  content: string;
  author: ImportAuthor;
  attachments: any[];
  embeds: {
    title: string;
    url: string;
    timestamp: string | null;
    description: string;
    color: string;
    thumbnail: {
      url: string;
      width: number;
      height: number;
    };
    images: any[];
    fields: any[];
    inlineEmojis: ImportEmoji[];
  }[];
  stickers: any[];
  reactions: ImportEmoji[];
  mentions: ImportAuthor[];
  reference: MessageType extends "Reply"
    ? {
        messageId: string;
        channelId: string;
        guildId: string;
      }
    : never;
  inlineEmojis: any[];
};

export type ImportAuthor = {
  id: string;
  name: string;
  discriminator: string;
  nickname: string;
  color: string;
  isBot: boolean;
  roles: {
    id: string;
    name: string;
    color: string;
    position: number;
  };
  avatarUrl: string;
};
export type ImportEmoji = {
  emoji: {
    id: string;
    name: string;
    code: string;
    isAnimated: boolean;
    imageUrl: string;
  };
  users: Exclude<ImportAuthor, "roles">[];
};
export type ImportChannel = {
  guild: {
    id: string;
    name: string;
    iconUrl: string;
  };
  channel: {
    id: string;
    type: "GuildPublicThread" | "GuildTextChat";
    categoryId: string;
    category: string;
    name: string;
    topic: string;
  };
  expotedAt: string;
  messages: DiscordMessage<any>[];
  messageCount: number;
};
