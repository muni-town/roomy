/**
 * Plain data types for Discord entities.
 *
 * These represent just the fields the bridge services actually use,
 * decoupling service logic from Discordeno's heavy type system.
 *
 * Types that are parsed from external JSON (file exports, API responses)
 * are defined as arktype schemas with inferred TypeScript types, so that
 * JSON validation can reuse the same schema and return the right type
 * without casting. Even types that aren't parsed from JSON are defined as
 * schemas here so their inferred types are consistent with the schema types.
 */

import { type } from "arktype";

// ─── Permission overwrite ──────────────────────────────────────────────

export const permissionOverwriteSchema = type({
	id: "string",
	"deny?": "string[]",
});
export type PermissionOverwriteData = typeof permissionOverwriteSchema.infer;

// ─── Users ─────────────────────────────────────────────────────────────

export const DiscordUserData = type({
	id: "string",
	name: "string",
	discriminator: "string",
	"globalName?": "string | null",
	"avatar?": "string | null",
	"isBot?": "boolean",
});
export type DiscordUserData = typeof DiscordUserData.infer;

// ─── Attachments & Media ───────────────────────────────────────────────

export const DiscordAttachmentData = type({
	id: "string",
	url: "string",
	filename: "string",
	"contentType?": "string",
	"size?": "number",
	"width?": "number",
	"height?": "number",
});
export type DiscordAttachmentData = typeof DiscordAttachmentData.infer;

// ─── Message Reference ─────────────────────────────────────────────────

export const DiscordMessageReference = type({
	messageId: "string | null",
	channelId: "string",
	guildId: "string",
});
export type DiscordMessageReference = typeof DiscordMessageReference.infer;

// ─── Reaction emoji ────────────────────────────────────────────────────

export const DiscordReactionEmoji = type({
	id: "string",
	name: "string",
	"animated?": "boolean",
});
export type DiscordReactionEmoji = typeof DiscordReactionEmoji.infer;

// ─── Reactions ─────────────────────────────────────────────────────────

export const DiscordReactionData = type({
	emoji: DiscordReactionEmoji,
	count: "number",
	userIds: "string[]",
});
export type DiscordReactionData = typeof DiscordReactionData.infer;

// ─── Stickers ──────────────────────────────────────────────────────────

export const DiscordStickerData = type({
	id: "string",
	formatType: "number",
});
export type DiscordStickerData = typeof DiscordStickerData.infer;

// ─── Embeds ────────────────────────────────────────────────────────────

export const DiscordEmbedData = type({
	"title?": "string",
	"url?": "string",
	"description?": "string",
	"color?": "number",
});
export type DiscordEmbedData = typeof DiscordEmbedData.infer;

// ─── Messages ──────────────────────────────────────────────────────────

export const DiscordMessageData = type({
	id: "string",
	channelId: "string",
	"guildId?": "string",
	type: "number",
	content: "string",
	timestamp: "number",
	"editedTimestamp?": "number",
	author: DiscordUserData,
	attachments: DiscordAttachmentData.array(),
	"embeds?": DiscordEmbedData.array().or("undefined"),
	"reactions?": DiscordReactionData.array().or("undefined"),
	"mentions?": DiscordUserData.array(),
	"mentionChannelIds?": "string[]",
	"stickerItems?": DiscordStickerData.array().or("undefined"),
	"messageReference?": DiscordMessageReference.or("undefined"),
});
export type DiscordMessageData = typeof DiscordMessageData.infer;

// ─── Channels ──────────────────────────────────────────────────────────

export const DiscordChannelData = type({
	id: "string",
	type: "number",
	"name?": "string",
	"parentId?": "string",
	"guildId?": "string",
	"topic?": "string | null",
	"permissionOverwrites?": permissionOverwriteSchema.array(),
});
export type DiscordChannelData = typeof DiscordChannelData.infer;

// ─── Guilds ────────────────────────────────────────────────────────────

export const DiscordGuildData = type({
	id: "string",
	"channels?": DiscordChannelData.array(),
});
export type DiscordGuildData = typeof DiscordGuildData.infer;

// ─── Helpers ───────────────────────────────────────────────────────────

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
export function mappingKindForChannel(channel: {
	type: number;
}): "channel" | "thread" {
	return THREAD_TYPES.has(channel.type) ? "thread" : "channel";
}

/** Discord message types the bridge cares about. */
export const MsgType = {
	Default: 0,
	ChannelNameChange: 4,
	ThreadCreated: 18,
	ThreadStarterMessage: 21,
} as const;
