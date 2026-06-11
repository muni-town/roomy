/**
 * Shared constants and fixture builders for discord-bridge service tests.
 *
 * All fixtures produce normalized types (DiscordMessageData, DiscordChannelData,
 * DiscordUserData) matching what the refactored services expect.
 */

import type {
  DiscordMessageData,
  DiscordChannelData,
  DiscordUserData,
  DiscordAttachmentData,
  DiscordMessageReference,
} from "../../../discord/data.ts";

// === Constants ===
export const SPACE_A = "did:web:space-a.example";
export const SPACE_B = "did:web:space-b.example";
export const SPACE_C = "did:web:space-c.example";
export const GUILD = "123456789012345670";
export const GUILD_2 = "123456789012345671";
export const CHANNEL = "123456789012345678";
export const CHANNEL_2 = "223456789012345678";
export const CHANNEL_3 = "323456789012345678";
export const THREAD = "423456789012345678";
export const PARENT_CHANNEL = "523456789012345678";
export const ROOMY_CHANNEL_ULID = "01JQ3YXK7X0A1B2C3D4E5F6G7H8";
export const ROOMY_THREAD_ULID = "01JQ3YXK7X0A1B2C3D4E5F6G7H9";
export const ROOMY_MESSAGE_ULID = "01JQ3YXK7X0A1B2C3D4E5F6G7IA";
export const ROOMY_MESSAGE_ULID_2 = "01JQ3YXK7X0A1B2C3D4E5F6G7IB";
export const USER_ID = "111111111111111111";
export const USER_ID_2 = "222222222222222222";

export const SNOWFLAKE_CHANNEL = BigInt(CHANNEL);
export const SNOWFLAKE_CHANNEL_2 = BigInt(CHANNEL_2);
export const SNOWFLAKE_THREAD = BigInt(THREAD);
export const SNOWFLAKE_USER = BigInt(USER_ID);
export const SNOWFLAKE_USER_2 = BigInt(USER_ID_2);

// === Discord User Fixtures ===

/** Build a DiscordUserData fixture. */
export function makeUser(overrides: Partial<DiscordUserData> = {}): DiscordUserData {
  return {
    id: overrides.id ?? USER_ID,
    name: overrides.name ?? "testuser",
    discriminator: overrides.discriminator ?? "1234",
    globalName: overrides.globalName ?? "Test User",
    avatar: overrides.avatar ?? null,
    isBot: overrides.isBot ?? false,
  };
}

// === Discord Message Fixtures ===

/** Build a DiscordMessageData fixture. */
export function makeMessage(overrides: Record<string, unknown> = {}): DiscordMessageData {
  const author = (overrides.author as DiscordUserData) ?? makeUser();
  return {
    id: (overrides.id as string) ?? "987654321",
    channelId: (overrides.channelId as string) ?? CHANNEL,
    guildId: (overrides.guildId as string) ?? GUILD,
    type: (overrides.type as number) ?? 0,
    content: (overrides.content as string) ?? "Hello world",
    timestamp: (overrides.timestamp as string) ?? String(Date.now()),
    editedTimestamp: (overrides.editedTimestamp as string | null) ?? null,
    author,
    attachments: (overrides.attachments as DiscordAttachmentData[]) ?? [],
    embeds: (overrides.embeds as any) ?? [],
    reactions: (overrides.reactions as any) ?? [],
    mentions: (overrides.mentions as DiscordUserData[]) ?? [],
    mentionChannelIds: (overrides.mentionChannelIds as any) ?? [],
    stickerItems: (overrides.stickerItems as any) ?? [],
    messageReference: (overrides.messageReference as DiscordMessageReference | undefined) ?? undefined,
  };
}

// === Discord Channel Fixtures ===

/** Build a DiscordChannelData fixture. */
export function makeChannel(overrides: Record<string, unknown> = {}): DiscordChannelData {
  const hasGuildId = "guildId" in overrides;
  const hasParentId = "parentId" in overrides;
  const hasName = "name" in overrides;
  return {
    id: (overrides.id as string) ?? CHANNEL,
    type: (overrides.type as number) ?? 0, // GuildText
    name: hasName ? (overrides.name as string | undefined) : "general",
    guildId: hasGuildId ? (overrides.guildId as string | undefined) : GUILD,
    parentId: hasParentId ? (overrides.parentId as string | undefined) : undefined,
    permissionOverwrites: (overrides.permissionOverwrites as Array<{ id: string; deny?: string[] }> | undefined) ?? undefined,
    topic: (overrides.topic as string | null | undefined) ?? undefined,
  };
}

/** Build a thread DiscordChannelData fixture. */
export function makeThread(overrides: Record<string, unknown> = {}): DiscordChannelData {
  return makeChannel({
    id: overrides.id ?? THREAD,
    type: overrides.type ?? 11, // PublicThread
    name: overrides.name ?? "my-thread",
    parentId: overrides.parentId ?? CHANNEL,
    guildId: overrides.guildId ?? GUILD,
    ...overrides,
  });
}

// === Discord Attachment Fixtures ===

export function makeAttachment(overrides: Record<string, unknown> = {}): DiscordAttachmentData {
  return {
    id: (overrides.id as string) ?? "1001",
    url: (overrides.url as string) ?? "https://cdn.discordapp.com/attachments/1/2/image.png",
    filename: (overrides.filename as string) ?? "image.png",
    contentType: (overrides.contentType as string) ?? "image/png",
    size: (overrides.size as number) ?? 1024,
    width: (overrides.width as number | undefined) ?? 800,
    height: (overrides.height as number | undefined) ?? 600,
  };
}

// === Pre-built fixtures ===

/** Pre-built message with an image attachment. */
export const MESSAGE_WITH_IMAGE = makeMessage({
  id: "1111111111",
  content: "Check this out",
  attachments: [makeAttachment()],
});

/** Pre-built message with a video attachment. */
export const MESSAGE_WITH_VIDEO = makeMessage({
  id: "1111111112",
  content: "Watch this",
  attachments: [makeAttachment({
    contentType: "video/mp4",
    filename: "video.mp4",
  } as Record<string, unknown>)],
});

/** Pre-built message with a file attachment (non-image, non-video). */
export const MESSAGE_WITH_FILE = makeMessage({
  id: "1111111113",
  content: "Here's a file",
  attachments: [makeAttachment({
    contentType: "application/pdf",
    filename: "doc.pdf",
  } as Record<string, unknown>)],
});

/** Pre-built message referencing another message (reply). */
export function makeReplyMessage(replyToSnowflake: string): DiscordMessageData {
  return makeMessage({
    id: "1111111114",
    content: "This is a reply",
    messageReference: {
      messageId: replyToSnowflake,
      channelId: CHANNEL,
      guildId: GUILD,
    },
  });
}

/** Pre-built ThreadStarterMessage (type 21). */
export function makeThreadStarterMessage(
  originalMsgSnowflake: string,
  threadSnowflake: string = THREAD,
  parentChannelSnowflake: string = CHANNEL,
): DiscordMessageData {
  return makeMessage({
    id: "1111111115",
    channelId: threadSnowflake,
    guildId: GUILD,
    type: 21,
    content: "",
    messageReference: {
      messageId: originalMsgSnowflake,
      channelId: parentChannelSnowflake,
      guildId: GUILD,
    },
  });
}

/** Message with user and channel mentions. */
export const MESSAGE_WITH_MENTIONS = makeMessage({
  id: "1111111116",
  content: "Hey <@111111111111111111>, check <#123456789012345678>",
  mentions: [{
    id: USER_ID,
    name: "testuser",
    globalName: "Test User",
    discriminator: "1234",
  }],
  mentionChannelIds: [CHANNEL],
});