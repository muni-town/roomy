/**
 * Normalizers: convert Discordeno types → plain DiscordMessageData etc.
 *
 * Each normalizer extracts only the fields the bridge services actually use.
 */

import { iconBigintToHash } from "../utils/hash.ts";
import type {
	DiscordAttachmentData,
	DiscordChannelData,
	DiscordMessageData,
	DiscordMessageReference,
	DiscordMessageSnapshotData,
	DiscordReactionData,
	DiscordStickerData,
	DiscordUserData,
} from "./data.ts";
import type { MessageProperties } from "./types.ts";

// ─── Messages ──────────────────────────────────────────────────────────────

export function normalizeMessage(msg: MessageProperties): DiscordMessageData {
	return {
		id: msg.id.toString(),
		channelId: msg.channelId.toString(),
		guildId: msg.guildId?.toString(),
		type: msg.type,
		content: msg.content ?? "",
		timestamp: msg.timestamp ?? Date.now(),
		editedTimestamp:
			msg.editedTimestamp != null ? msg.editedTimestamp : undefined,
		webhookId: msg.webhookId?.toString(),
		author: normalizeUser(msg.author),
		attachments: (msg.attachments ?? []).map(normalizeAttachment),
		embeds: [], // services don't use embed content today
		reactions: (msg.reactions ?? []).map(normalizeReaction),
		mentions: (msg.mentions ?? []).map(normalizeUser),
		mentionChannelIds: msg.mentionedChannelIds?.map(String),
		stickerItems: (msg.stickerItems ?? []).map(normalizeSticker),
		messageReference: normalizeMessageReference(msg.messageReference),
		flags: msg.flags?.toJSON(),
		messageSnapshots: (msg.messageSnapshots ?? []).map(
			normalizeMessageSnapshot,
		),
	};
}

/**
 * Normalize a DiscordMessageSnapshot (forwarded-message snapshot).
 *
 * The snapshot's inner message is a Pick of the original message's fields
 * (content, timestamp, attachments, …) — no author. Only the fields the
 * bridge uses are extracted.
 */
function normalizeMessageSnapshot(snapshot: {
	message: {
		content?: string;
		timestamp?: number;
		attachments?: Array<{
			id: bigint;
			url: string;
			filename: string;
			contentType?: string;
			size?: number;
			width?: number;
			height?: number;
		}>;
	};
}): DiscordMessageSnapshotData {
	return {
		message: {
			content: snapshot.message.content ?? "",
			timestamp: snapshot.message.timestamp ?? Date.now(),
			attachments: (snapshot.message.attachments ?? []).map(
				normalizeAttachment,
			),
		},
	};
}

interface NarrowMessageRef {
	messageId?: bigint;
	channelId?: bigint;
	guildId?: bigint;
}

function normalizeMessageReference(
	ref: NarrowMessageRef | undefined,
): DiscordMessageReference | undefined {
	if (!ref) return undefined;
	return {
		messageId: ref.messageId?.toString() ?? null,
		channelId: String(ref.channelId ?? ""),
		guildId: String(ref.guildId ?? ""),
	};
}

// ─── Users ─────────────────────────────────────────────────────────────────

export function normalizeUser(user: {
	id: bigint;
	username: string;
	globalName?: string | null;
	discriminator?: string;
	avatar?: bigint | null;
}): DiscordUserData {
	return {
		id: user.id.toString(),
		name: user.username,
		discriminator: user.discriminator ?? "0",
		globalName: user.globalName ?? null,
		avatar: user.avatar != null ? iconBigintToHash(user.avatar) : null,
	};
}

/** Normalize a Discordeno user to the DiscordUserProfile shape (used by profile-sync before we fully migrate). */
export function normalizeUserToProfile(user: {
	id: bigint;
	username: string;
	globalName?: string | null;
	discriminator?: string;
	avatar?: bigint | null;
}): {
	id: bigint;
	username: string;
	globalName?: string;
	discriminator: string;
	avatar?: bigint;
} {
	return {
		id: user.id,
		username: user.username,
		globalName: user.globalName ?? undefined,
		discriminator: user.discriminator ?? "0",
		avatar: user.avatar ?? undefined,
	};
}

// ─── Channels ──────────────────────────────────────────────────────────────

/** Minimal channel shape that normalizeChannel reads. */
interface NormalizableChannel {
	id: bigint | string;
	type: number;
	name?: string;
	parentId?: bigint | string | null;
	guildId?: bigint | string;
	ownerId?: bigint | string | null;
	lastMessageId?: bigint | string | null;
	position?: number;
	permissionOverwrites?: Array<{
		id: bigint | string;
		deny?: string[] | string;
	}>;
}
export function normalizeChannel(ch: NormalizableChannel): DiscordChannelData {
	return {
		id: ch.id.toString(),
		type: ch.type,
		name: ch.name,
		parentId: ch.parentId?.toString(),
		guildId: ch.guildId?.toString(),
		ownerId: ch.ownerId?.toString(),
		position: ch.position,
		lastMessageId: ch.lastMessageId?.toString() ?? null,
		permissionOverwrites: ch.permissionOverwrites?.map((o) => ({
			id: o.id.toString(),
			deny: typeof o.deny === "string" ? [o.deny] : o.deny,
		})),
	};
}

// ─── Attachments ───────────────────────────────────────────────────────────

function normalizeAttachment(att: {
	id: bigint;
	url: string;
	filename: string;
	contentType?: string;
	size?: number;
	width?: number;
	height?: number;
}): DiscordAttachmentData {
	return {
		id: att.id.toString(),
		url: att.url,
		filename: att.filename,
		contentType: att.contentType,
		size: att.size,
		width: att.width,
		height: att.height,
	};
}

// ─── Reactions ─────────────────────────────────────────────────────────────

function normalizeReaction(r: {
	emoji: { id?: bigint; name?: string };
	count: number;
}): DiscordReactionData {
	return {
		emoji: {
			id: r.emoji.id?.toString() ?? "",
			name: r.emoji.name ?? "",
		},
		count: r.count,
		userIds: [],
	};
}

// ─── Stickers ──────────────────────────────────────────────────────────────

function normalizeSticker(s: {
	id: bigint;
	formatType: number;
}): DiscordStickerData {
	return {
		id: s.id.toString(),
		formatType: s.formatType,
	};
}

// ─── Embeds ────────────────────────────────────────────────────────────────

// Not needed — services don't inspect embed contents.
