import {
	newUlid,
	toBytes,
	Ulid,
	Did,
	type Event,
	type Attachment,
} from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import type { DiscordMessageData, DiscordUserData } from "../discord/data.ts";
import { MsgType } from "../discord/data.ts";
import { syncUserProfile } from "./profile-sync.ts";
import { createLogger } from "../logger.ts";
import { resolveMentions, type MentionContext } from "./mention-resolver.ts";

const log = createLogger("ingest");

export async function ingestDiscordMessage(
	message: DiscordMessageData,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	guildIdOverride?: string,
	spaceDidOverride?: string,
	resolveChannelName?: (snowflake: string) => Promise<string | undefined>,
	backfill = false,
): Promise<{ synced: number; skipped: number }> {
	const channelId = message.channelId;
	const messageId = message.id;
	const guildId = guildIdOverride ?? message.guildId;

	if (!guildId) {
		log.debug(`Skipping message ${messageId}: no guildId`);
		return { synced: 0, skipped: 1 };
	}

	// Determine which spaces should receive this channel's events.
	let targetSpaces: string[];
	if (spaceDidOverride) {
		const allTargets = repo.getTargetSpacesForChannel(guildId, channelId);
		targetSpaces = allTargets.includes(spaceDidOverride)
			? [spaceDidOverride]
			: [];
	} else {
		targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
	}
	if (targetSpaces.length === 0) {
		log.debug(
			`Skipping message ${messageId}: channel ${channelId} not bridged`,
		);
		return { synced: 0, skipped: 1 };
	}

	// ThreadStarterMessage (type 21): forward original message into thread
	if (message.type === MsgType.ThreadStarterMessage) {
		return handleThreadStarterMessage(message, repo, roomy);
	}

	// Skip system messages
	if (
		message.type === MsgType.ThreadCreated ||
		message.type === MsgType.ChannelNameChange
	) {
		return { synced: 0, skipped: 1 };
	}

	// Pre-resolve channel names from mentionedChannelIds (before per-space loop).
	const channelNames = new Map<string, string>();
	if (resolveChannelName && message.mentionChannelIds) {
		const results = await Promise.all(
			message.mentionChannelIds.map(async (idStr) => {
				const name = await resolveChannelName(idStr);
				return { idStr, name } as const;
			}),
		);
		for (const { idStr, name } of results) {
			if (name) channelNames.set(idStr, name);
		}
	}

	let synced = 0;

	for (const spaceDid of targetSpaces) {
		// Dedup: already synced to this space?
		const existing = repo.getRoomyId(spaceDid, "message", messageId);
		if (existing) {
			log.debug(`Skipping message ${messageId}: already synced to ${spaceDid}`);
			continue;
		}

		// Resolve the Roomy room for this channel or thread
		const roomyRoomId = repo.getRoomyRoomId(spaceDid, channelId);
		if (!roomyRoomId) {
			log.warn(
				`No Roomy room mapping for channel ${channelId} in ${spaceDid}, skipping message`,
			);
			continue;
		}

		// Build attachments
		const attachments = buildAttachments(message, repo, spaceDid);

		// Sync author profile before sending the message.
		await syncUserProfile(message.author, [spaceDid], repo, roomy);

		// Skip messages with no content and no attachments
		if (!message.content && attachments.length === 0) {
			continue;
		}

		// Resolve Discord mention syntax into clean Markdown (per-space).
		const roomyRoomIds = new Map<string, string>();
		for (const [snowflake] of channelNames) {
			const roomyId = repo.getRoomyRoomId(spaceDid, snowflake);
			if (roomyId) roomyRoomIds.set(snowflake, roomyId);
		}
		const mentionCtx: MentionContext = {
			channelNames,
			roomyRoomIds,
		};
		const userMentions = (message.mentions ?? []).map((m) => ({
			id: m.id,
			username: m.name,
			globalName: m.globalName,
		}));
		const resolvedContent = resolveMentions(
			message.content || "",
			userMentions,
			mentionCtx,
		);
		const eventUlid = newUlid();
		const extensions: Record<string, unknown> = {
			"space.roomy.extension.discordMessageOrigin.v0": {
				$type: "space.roomy.extension.discordMessageOrigin.v0",
				snowflake: messageId,
				channelId,
				guildId,
			},
			"space.roomy.extension.authorOverride.v0": {
				$type: "space.roomy.extension.authorOverride.v0",
				did: Did.assert(`did:discord:${message.author.id}`),
			},
			"space.roomy.extension.timestampOverride.v0": {
				$type: "space.roomy.extension.timestampOverride.v0",
				timestamp: message.timestamp
					? new Date(message.timestamp).getTime()
					: Date.now(),
			},
		};

		if (attachments.length > 0) {
			extensions["space.roomy.extension.attachments.v0"] = {
				$type: "space.roomy.extension.attachments.v0",
				attachments,
			};
		}

		const event: Event = {
			id: eventUlid,
			room: Ulid.assert(roomyRoomId),
			$type: "space.roomy.message.createMessage.v0",
			body: {
				mimeType: "text/markdown",
				data: toBytes(new TextEncoder().encode(resolvedContent)),
			},
			extensions,
		};

		try {
			await roomy.sendEvent(spaceDid, event);

			// Register mapping
			repo.registerMapping(spaceDid, "message", messageId, eventUlid);

			// Advance cursor only during live ingestion, not during backfill
			if (!backfill) {
				repo.setChannelCursor(spaceDid, channelId, messageId);
			}

			log.info(`Synced message ${messageId} → ${eventUlid} in ${spaceDid}`);
			synced++;
		} catch (err) {
			log.error(`Failed to send message ${messageId} to ${spaceDid}`, err);
		}
	}

	return { synced, skipped: targetSpaces.length - synced };
}

function buildAttachments(
	message: DiscordMessageData,
	repo: BridgeRepository,
	spaceDid: string,
): Attachment[] {
	const attachments: Attachment[] = [];

	// Reply attachment
	if (message.messageReference?.messageId) {
		const targetIdStr = message.messageReference.messageId;
		const replyTargetId = repo.getRoomyId(spaceDid, "message", targetIdStr);
		if (replyTargetId) {
			attachments.push({
				$type: "space.roomy.attachment.reply.v0",
				target: Ulid.assert(replyTargetId),
			});
		}
	}

	// Media attachments
	for (const att of message.attachments || []) {
		if (att.contentType?.startsWith("image/")) {
			attachments.push({
				$type: "space.roomy.attachment.image.v0",
				uri: att.url,
				mimeType: att.contentType,
				width: att.width,
				height: att.height,
				size: att.size,
			});
		} else if (att.contentType?.startsWith("video/")) {
			attachments.push({
				$type: "space.roomy.attachment.video.v0",
				uri: att.url,
				mimeType: att.contentType,
				width: att.width,
				height: att.height,
				size: att.size,
			});
		} else {
			attachments.push({
				$type: "space.roomy.attachment.file.v0",
				uri: att.url,
				mimeType: att.contentType || "application/octet-stream",
				name: att.filename,
				size: att.size,
			});
		}
	}

	// Sticker attachments
	for (const sticker of message.stickerItems || []) {
		const id = sticker.id;
		if (sticker.formatType === 4) {
			attachments.push({
				$type: "space.roomy.attachment.image.v0",
				uri: `https://cdn.discordapp.com/stickers/${id}.gif`,
				mimeType: "image/gif",
			});
		} else if (sticker.formatType === 1 || sticker.formatType === 2) {
			attachments.push({
				$type: "space.roomy.attachment.image.v0",
				uri: `https://cdn.discordapp.com/stickers/${id}.png`,
				mimeType: "image/png",
			});
		}
	}

	return attachments;
}

/**
 * Handle Discord ThreadStarterMessage (type 21): forward the original message
 * into the thread's Roomy room.
 */
async function handleThreadStarterMessage(
	message: DiscordMessageData,
	repo: BridgeRepository,
	roomy: RoomyGateway,
): Promise<{ synced: number; skipped: number }> {
	const threadId = message.channelId;
	const messageId = message.id;
	const guildId = message.guildId;

	if (
		!guildId ||
		!message.messageReference?.messageId ||
		!message.messageReference?.channelId
	) {
		return { synced: 0, skipped: 1 };
	}

	const originalMsgId = message.messageReference.messageId;
	const parentChannelId = message.messageReference.channelId;

	const targetSpaces = repo.getTargetSpacesForChannel(guildId, threadId);
	if (targetSpaces.length === 0) {
		log.debug(
			`Skipping thread starter ${messageId}: thread ${threadId} not bridged`,
		);
		return { synced: 0, skipped: 1 };
	}

	let synced = 0;

	for (const spaceDid of targetSpaces) {
		const existing = repo.getRoomyId(spaceDid, "message", messageId);
		if (existing) {
			log.debug(
				`Skipping thread starter ${messageId}: already synced to ${spaceDid}`,
			);
			continue;
		}

		const threadRoomyId = repo.getRoomyId(spaceDid, "thread", threadId);
		if (!threadRoomyId) {
			log.debug(
				`No Roomy room for thread ${threadId} in ${spaceDid}, skipping forward`,
			);
			continue;
		}

		const originalRoomyId = repo.getRoomyId(spaceDid, "message", originalMsgId);
		if (!originalRoomyId) {
			log.debug(
				`Original message ${originalMsgId} not synced to ${spaceDid}, skipping forward`,
			);
			continue;
		}

		const fromRoomId = repo.getRoomyId(spaceDid, "channel", parentChannelId);
		if (!fromRoomId) {
			log.debug(
				`No Roomy room for parent channel ${parentChannelId} in ${spaceDid}, skipping forward`,
			);
			continue;
		}

		const forwardUlid = newUlid();
		const forwardEvent: Event = {
			id: forwardUlid,
			room: Ulid.assert(threadRoomyId),
			$type: "space.roomy.message.forwardMessages.v0",
			messageIds: [Ulid.assert(originalRoomyId)],
			fromRoomId: Ulid.assert(fromRoomId),
		};

		try {
			await roomy.sendEvent(spaceDid, forwardEvent);

			repo.registerMapping(spaceDid, "message", messageId, forwardUlid);

			log.info(
				`Forwarded original message ${originalMsgId} to thread ${threadId} in ${spaceDid}`,
			);
			synced++;
		} catch (err) {
			log.error(
				`Failed to forward message to thread ${threadId} in ${spaceDid}`,
				err,
			);
		}
	}

	return { synced, skipped: targetSpaces.length - synced };
}
