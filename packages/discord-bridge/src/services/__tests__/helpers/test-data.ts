/**
 * Shared constants and fixture builders for discord-bridge service tests.
 */

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

/** BigInt snowflakes for convenience. */
export const SNOWFLAKE_CHANNEL = BigInt(CHANNEL);
export const SNOWFLAKE_CHANNEL_2 = BigInt(CHANNEL_2);
export const SNOWFLAKE_THREAD = BigInt(THREAD);
export const SNOWFLAKE_USER = BigInt(USER_ID);
export const SNOWFLAKE_USER_2 = BigInt(USER_ID_2);

// === Discord Message Fixtures ===

/** Minimal author object matching DiscordUserProfile interface. */
export function makeAuthor(overrides: Partial<{
  id: bigint;
  username: string;
  globalName?: string;
  avatar?: bigint;
  discriminator: string;
}> = {}) {
  return {
    id: overrides.id ?? SNOWFLAKE_USER,
    username: overrides.username ?? "testuser",
    globalName: overrides.globalName ?? "Test User",
    avatar: overrides.avatar ?? undefined,
    discriminator: overrides.discriminator ?? "1234",
  };
}

/** Build a minimal MessageProperties fixture for testing. */
export function makeMessage(overrides: Record<string, unknown> = {}) {
  const author = (overrides.author as ReturnType<typeof makeAuthor>) ?? makeAuthor();
  return {
    id: (overrides.id as bigint) ?? BigInt("987654321"),
    channelId: (overrides.channelId as bigint) ?? SNOWFLAKE_CHANNEL,
    guildId: (overrides.guildId as bigint) ?? BigInt(GUILD),
    content: (overrides.content as string) ?? "Hello world",
    author,
    type: (overrides.type as number) ?? 0,
    timestamp: (overrides.timestamp as number) ?? Date.now(),
    editedTimestamp: (overrides.editedTimestamp as number | null) ?? null,
    attachments: (overrides.attachments as Array<Record<string, unknown>>) ?? [],
    mentions: (overrides.mentions as Array<Record<string, unknown>>) ?? [],
    mentionedChannelIds: (overrides.mentionedChannelIds as Array<bigint>) ?? [],
    messageReference: (overrides.messageReference as Record<string, unknown> | null) ?? null,
    stickerItems: (overrides.stickerItems as Array<Record<string, unknown>>) ?? [],
    webhookId: (overrides.webhookId as bigint | undefined) ?? undefined,
    reactions: (overrides.reactions as Array<Record<string, unknown>>) ?? [],
    mentionedRoleIds: (overrides.mentionedRoleIds as bigint[]) ?? [],
  };
}

// === Discord Channel Fixtures ===

/** Build a minimal ChannelProperties fixture for testing. */
export function makeChannel(overrides: Record<string, unknown> = {}) {
  const hasGuildId = "guildId" in overrides;
  const hasParentId = "parentId" in overrides;
  const hasName = "name" in overrides;
  return {
    id: (overrides.id as bigint) ?? SNOWFLAKE_CHANNEL,
    type: (overrides.type as number) ?? 0, // GuildText
    name: hasName ? (overrides.name as string | undefined) : "general",
    guildId: hasGuildId ? (overrides.guildId as bigint | undefined) : BigInt(GUILD),
    parentId: hasParentId ? (overrides.parentId as bigint | undefined) : undefined,
    permissionOverwrites: (overrides.permissionOverwrites as Array<Record<string, unknown>> | undefined) ?? undefined,
    lastMessageId: (overrides.lastMessageId as bigint | undefined) ?? BigInt("999999999"),
  };
}

/** Build a thread ChannelProperties fixture. */
export function makeThread(overrides: Record<string, unknown> = {}) {
  return makeChannel({
    id: overrides.id ?? SNOWFLAKE_THREAD,
    type: overrides.type ?? 11, // PublicThread
    name: overrides.name ?? "my-thread",
    parentId: overrides.parentId ?? SNOWFLAKE_CHANNEL,
    guildId: overrides.guildId ?? BigInt(GUILD),
    ...overrides,
  });
}

// === Emoji Fixtures ===

export function makeEmoji(overrides: Record<string, unknown> = {}) {
  return {
    id: (overrides.id as bigint | undefined) ?? undefined,
    name: (overrides.name as string) ?? "👍",
    animated: (overrides.animated as boolean) ?? false,
  };
}

// === Attachment Fixtures ===

export function makeAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: (overrides.id as bigint) ?? BigInt("1001"),
    filename: (overrides.filename as string) ?? "image.png",
    contentType: (overrides.contentType as string) ?? "image/png",
    size: (overrides.size as number) ?? 1024,
    url: (overrides.url as string) ?? "https://cdn.discordapp.com/attachments/1/2/image.png",
    proxyUrl: (overrides.proxyUrl as string) ?? "https://media.discordapp.net/attachments/1/2/image.png",
    width: (overrides.width as number | undefined) ?? 800,
    height: (overrides.height as number | undefined) ?? 600,
  };
}

/** Pre-built message with an image attachment. */
export const MESSAGE_WITH_IMAGE = makeMessage({
  id: BigInt("1111111111"),
  content: "Check this out",
  attachments: [makeAttachment()],
});

/** Pre-built message with a video attachment. */
export const MESSAGE_WITH_VIDEO = makeMessage({
  id: BigInt("1111111112"),
  content: "Watch this",
  attachments: [makeAttachment({
    contentType: "video/mp4",
    filename: "video.mp4",
  })],
});

/** Pre-built message with a file attachment (non-image, non-video). */
export const MESSAGE_WITH_FILE = makeMessage({
  id: BigInt("1111111113"),
  content: "Here's a file",
  attachments: [makeAttachment({
    contentType: "application/pdf",
    filename: "doc.pdf",
  })],
});

/** Pre-built message referencing another message (reply). */
export function makeReplyMessage(replyToSnowflake: bigint): Record<string, unknown> {
  return makeMessage({
    id: BigInt("1111111114"),
    content: "This is a reply",
    messageReference: {
      messageId: replyToSnowflake,
      channelId: SNOWFLAKE_CHANNEL,
      guildId: BigInt(GUILD),
    },
  });
}

/** Pre-built ThreadStarterMessage (type 21). */
export function makeThreadStarterMessage(
  originalMsgSnowflake: bigint,
  threadSnowflake: bigint = SNOWFLAKE_THREAD,
  parentChannelSnowflake: bigint = SNOWFLAKE_CHANNEL,
) {
  return makeMessage({
    id: BigInt("1111111115"),
    channelId: threadSnowflake,
    guildId: BigInt(GUILD),
    type: 21,
    content: "",
    messageReference: {
      messageId: originalMsgSnowflake as bigint,
      channelId: parentChannelSnowflake as bigint,
      guildId: BigInt(GUILD),
    },
  });
}

/** Message with user and channel mentions. */
export const MESSAGE_WITH_MENTIONS = makeMessage({
  id: BigInt("1111111116"),
  content: "Hey <@111111111111111111>, check <#123456789012345678>",
  mentions: [{
    id: SNOWFLAKE_USER,
    username: "testuser",
    globalName: "Test User",
    discriminator: "1234",
  }],
  mentionedChannelIds: [SNOWFLAKE_CHANNEL],
});

/** Message with custom emoji. */
export const MESSAGE_WITH_CUSTOM_EMOJI = makeMessage({
  id: BigInt("1111111117"),
  content: "Look at this <:blob:999999999999999999> and <a:party:888888888888888888>",
});