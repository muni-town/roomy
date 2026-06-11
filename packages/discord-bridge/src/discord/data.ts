/**
 * Plain data types for Discord entities.
 *
 * These represent just the fields the bridge services actually use,
 * decoupling service logic from Discordeno's heavy type system.
 */

// ─── Messages ──────────────────────────────────────────────────────────────

export interface DiscordMessageData {
  id: string;
  channelId: string;
  guildId?: string;
  type: number;
  content: string;
  timestamp: string;
  editedTimestamp: string | null;
  author: DiscordUserData;
  attachments: DiscordAttachmentData[];
  embeds: DiscordEmbedData[];
  reactions: DiscordReactionData[];
  mentions: DiscordUserData[];
  mentionChannelIds?: string[];
  stickerItems?: DiscordStickerData[];
  messageReference?: DiscordMessageReference;
}

export interface DiscordMessageReference {
  messageId: string | null;
  channelId: string;
  guildId: string;
}

// ─── Users ─────────────────────────────────────────────────────────────────

export interface DiscordUserData {
  id: string;
  name: string;
  discriminator: string;
  globalName?: string | null;
  avatar?: string | null;
  isBot?: boolean;
}

// ─── Channels ──────────────────────────────────────────────────────────────

export interface DiscordChannelData {
  id: string;
  type: number;
  name?: string;
  parentId?: string;
  guildId?: string;
  topic?: string | null;
  permissionOverwrites?: Array<{ id: string; deny?: string[] }>;
}

export interface DiscordGuildData {
  id: string;
  channels?: DiscordChannelData[];
}

// ─── Attachments & Media ───────────────────────────────────────────────────

export interface DiscordAttachmentData {
  id: string;
  url: string;
  filename: string;
  contentType?: string;
  size?: number;
  width?: number;
  height?: number;
}

// ─── Reactions ─────────────────────────────────────────────────────────────

export interface DiscordReactionData {
  emoji: { id: string; name: string; animated?: boolean };
  count: number;
  userIds: string[];
}

// ─── Stickers ──────────────────────────────────────────────────────────────

export interface DiscordStickerData {
  id: string;
  formatType: number;
}

// ─── Embeds ────────────────────────────────────────────────────────────────

export interface DiscordEmbedData {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Channel types that represent top-level text channels.
 */
export const CHANNEL_TYPES = new Set([0, 5]); // GuildText, GuildAnnouncement

/**
 * Channel types that represent threads (public, private, announcement).
 */
export const THREAD_TYPES = new Set([11, 12, 10]); // PublicThread, PrivateThread, AnnouncementThread

/** Private thread type — excluded from sync. */
export const PRIVATE_THREAD = 12;

/** Any channel type that can carry messages. */
export const MESSAGE_CHANNEL_TYPES = new Set([
  ...CHANNEL_TYPES,
  ...THREAD_TYPES,
]);

/**
 * Check if a channel is publicly visible by examining whether the @everyone
 * role (whose ID equals the guild ID) has VIEW_CHANNEL explicitly denied.
 * Channels without a matching deny overwrite are public by default.
 */
export function isChannelPublic(
  channel: { permissionOverwrites?: Array<{ id: string; deny?: string[] }> },
  guildId: string,
): boolean {
  const overwrites = channel.permissionOverwrites;
  if (!overwrites || overwrites.length === 0) return true;
  const everyoneOverwrite = overwrites.find((o) => o.id === guildId);
  if (!everyoneOverwrite) return true;
  return !everyoneOverwrite.deny?.includes("VIEW_CHANNEL");
}

/** Mapping from Discord channel types to sensible kind strings. */
export function mappingKindForChannel(
  channel: { type: number },
): "channel" | "thread" {
  return THREAD_TYPES.has(channel.type) ? "thread" : "channel";
}

/** Discord message types the bridge cares about. */
export const MsgType = {
  Default: 0,
  ChannelNameChange: 4,
  ThreadCreated: 18,
  ThreadStarterMessage: 21,
} as const;