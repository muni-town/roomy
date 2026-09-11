import { appendFile } from "node:fs/promises";
import {
	type Attachment,
	Did,
	type Event,
	newUlid,
	serializeBlocks,
	toBytes,
	Ulid,
} from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { DiscordMessageData } from "../discord/data.ts";
import { MESSAGE_FLAG_HAS_SNAPSHOT, MsgType } from "../discord/data.ts";
import { createLogger } from "../logger.ts";
import { getCapacityGate } from "../roomy/capacity.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import {
	type MentionContext,
	resolveMentionsToBlocks,
} from "./mention-resolver.ts";
import { syncUserProfile } from "./profile-sync.ts";

const log = createLogger("ingest");

// ── Skipped-message log (JSONL) ─────────────────────────────────────

const SKIP_LOG_PATH = process.env.ROOMY_SKIP_LOG;

/** Append one JSON line recording a skipped message. No-op if ROOMY_SKIP_LOG is unset. */
function writeSkipRecord(
	reason: string,
	message: DiscordMessageData,
	detail?: string,
): void {
	if (!SKIP_LOG_PATH) return;
	const record = {
		timestamp: Date.now(),
		reason,
		messageId: message.id,
		channelId: message.channelId,
		guildId: message.guildId,
		type: message.type,
		content: message.content?.slice(0, 200),
		authorId: message.author.id,
		detail,
	};
	// Fire-and-forget — never throw from ingest.
	appendFile(SKIP_LOG_PATH, `${JSON.stringify(record)}\n`).catch(() => {});
}

/**
 * Build the snowflake → Roomy room ULID map for channel/thread mentions.
 *
 * Scans the raw content for every `<#id>` reference rather than relying on
 * `message.mentionChannelIds` alone: Discord doesn't always include threads
 * in that field, and it's still empty when name resolution fails. Scanning
 * the content directly guarantees a bridged channel/thread mention always
 * becomes a link to its Roomy room (the parser emits a `#roomRef`/`#link`
 * facet whenever the ULID is present).
 */
export function buildRoomyRoomIds(
	content: string,
	repo: BridgeRepository,
	spaceDid: string,
): Map<string, string> {
	const roomyRoomIds = new Map<string, string>();
	const refs = new Set<string>();
	for (const m of content.matchAll(/<#(\d+)>/g)) {
		const id = m[1];
		if (id) refs.add(id);
	}
	for (const snowflake of refs) {
		const roomyId = repo.getRoomyRoomId(spaceDid, snowflake);
		if (roomyId) roomyRoomIds.set(snowflake, roomyId);
	}
	return roomyRoomIds;
}

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
		writeSkipRecord("no_guild_id", message);
		return { synced: 0, skipped: 1 };
	}

	// Skip webhook messages sent by this bridge (echo prevention).
	// The webhook response and the gateway event are independent async
	// paths, so the registerMapping call in the router may not have
	// completed before the gateway event arrives. Checking against our
	// stored webhook IDs is deterministic and doesn't depend on timing.
	// Other integrations' webhooks are not skipped.
	//
	// During backfill this check is skipped: the webhook may have been
	// created by a previous bridge instance (ensureWebhook reuses existing
	// webhooks from the DB), so isOurWebhook would return true for
	// historical messages that should be ingested into the new space.
	// The dedup check (getRoomyId) below handles echo prevention during
	// backfill — the router registers the mapping synchronously right after
	// the webhook message is created; backfill only observes the message via
	// a later REST fetch, so the mapping always exists by the time backfill
	// reaches it.
	if (!backfill && message.webhookId && repo.isOurWebhook(message.webhookId)) {
		log.debug(`Skipping own webhook message ${messageId}`);
		writeSkipRecord("own_webhook_message", message);
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
		writeSkipRecord("channel_not_bridged", message, `channel ${channelId}`);
		return { synced: 0, skipped: 1 };
	}

	// ThreadStarterMessage (type 21): forward original message into thread
	if (message.type === MsgType.ThreadStarterMessage) {
		writeSkipRecord("thread_starter", message);
		return handleThreadStarterMessage(message, repo, roomy);
	}

	// Forwarded message: forward the original message into the target
	// channel's Roomy room. Discord has no dedicated forward message type —
	// a forward is an ordinary DEFAULT message (type 0) carrying the
	// HAS_SNAPSHOT flag (1 << 14) and a `messageSnapshots` array, with
	// `messageReference` pointing at the original. Forwards must not be
	// treated as ordinary (empty) messages or as replies.
	const isForward =
		((message.flags ?? 0) & MESSAGE_FLAG_HAS_SNAPSHOT) !== 0 ||
		(message.messageSnapshots?.length ?? 0) > 0;
	if (isForward) {
		writeSkipRecord("forward", message);
		return handleForwardMessage(message, repo, roomy);
	}

	// Skip system messages
	if (
		message.type === MsgType.ThreadCreated ||
		message.type === MsgType.ChannelNameChange
	) {
		log.info(
			`Skipping message ${messageId}: system message (type ${message.type})`,
		);
		writeSkipRecord("system_message", message, `type ${message.type}`);
		return { synced: 0, skipped: 1 };
	}

	// Pre-resolve channel/thread names (before per-space loop). Collect every
	// channel/thread referenced in the content via <#id>, plus Discord's
	// mentionChannelIds (some overlap). Discord omits threads from
	// mentionChannelIds, so scanning the content guarantees a thread mention
	// gets both its display name and its Roomy link.
	const channelNames = new Map<string, string>();
	if (resolveChannelName) {
		const refs = new Set<string>(message.mentionChannelIds ?? []);
		for (const m of (message.content ?? "").matchAll(/<#(\d+)>/g)) {
			if (m[1]) refs.add(m[1]);
		}
		const results = await Promise.all(
			[...refs].map(async (idStr) => {
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
			writeSkipRecord("already_synced", message, spaceDid);
			continue;
		}

		// Capacity enforcement: halt sync for this space while the bridged
		// guild is over the space's member capacity.
		if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
			log.warn(
				`capacity: sync halted for ${spaceDid} (guild ${guildId}); skipping message ${messageId}`,
				{ guildId, spaceDid, messageId },
			);
			writeSkipRecord("capacity_over_limit", message, spaceDid);
			continue;
		}

		// Resolve the Roomy room for this channel or thread
		const roomyRoomId = repo.getRoomyRoomId(spaceDid, channelId);
		if (!roomyRoomId) {
			log.warn(
				`No Roomy room mapping for channel ${channelId} in ${spaceDid}, skipping message`,
			);
			writeSkipRecord(
				"no_room_mapping",
				message,
				`channel ${channelId} in ${spaceDid}`,
			);
			continue;
		}

		// Build attachments
		const attachments = buildAttachments(message, repo, spaceDid);

		// Sync author profile before sending the message.
		await syncUserProfile(message.author, [spaceDid], repo, roomy, guildId);

		// Skip messages with no content and no attachments
		if (!message.content && attachments.length === 0) {
			log.warn(
				`Skipping message ${messageId} in ${spaceDid}: no content and no attachments`,
			);
			writeSkipRecord("empty_message", message, spaceDid);
			continue;
		}

		// Resolve Discord mention syntax into clean Markdown (per-space).
		// Build the room map from the content's <#id> references so bridged
		// thread/channel mentions always get a link, even if the display name
		// couldn't be resolved (falls back to the snowflake text).
		const roomyRoomIds = buildRoomyRoomIds(
			message.content || "",
			repo,
			spaceDid,
		);
		const mentionCtx: MentionContext = {
			channelNames,
			roomyRoomIds,
		};
		const userMentions = (message.mentions ?? []).map((m) => ({
			id: m.id,
			username: m.name,
			globalName: m.globalName,
		}));
		const blocks = resolveMentionsToBlocks(
			message.content || "",
			userMentions,
			mentionCtx,
			spaceDid,
		);
		const serializedBody = serializeBlocks(blocks);
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
				mimeType: serializedBody.mimeType,
				data: toBytes(serializedBody.data),
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

			// log.info(`Synced message ${messageId} → ${eventUlid} in ${spaceDid}`);
			synced++;
		} catch (err) {
			log.error(`Failed to send message ${messageId} to ${spaceDid}`, err);
			writeSkipRecord("send_failed", message, spaceDid);
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
		writeSkipRecord("thread_starter_missing_ref", message);
		return { synced: 0, skipped: 1 };
	}

	const originalMsgId = message.messageReference.messageId;
	const parentChannelId = message.messageReference.channelId;

	const targetSpaces = repo.getTargetSpacesForChannel(guildId, threadId);
	if (targetSpaces.length === 0) {
		log.debug(
			`Skipping thread starter ${messageId}: thread ${threadId} not bridged`,
		);
		writeSkipRecord(
			"thread_starter_not_bridged",
			message,
			`thread ${threadId}`,
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
			writeSkipRecord("thread_starter_already_synced", message, spaceDid);
			continue;
		}

		// Capacity enforcement: halt sync for this space while the bridged
		// guild is over the space's member capacity.
		if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
			log.warn(
				`capacity: sync halted for ${spaceDid} (guild ${guildId}); skipping thread starter ${messageId}`,
				{ guildId, spaceDid, messageId },
			);
			writeSkipRecord("capacity_over_limit", message, spaceDid);
			continue;
		}

		const threadRoomyId = repo.getRoomyId(spaceDid, "thread", threadId);
		if (!threadRoomyId) {
			log.debug(
				`No Roomy room for thread ${threadId} in ${spaceDid}, skipping forward`,
			);
			writeSkipRecord(
				"thread_starter_no_thread_room",
				message,
				`thread ${threadId} in ${spaceDid}`,
			);
			continue;
		}

		const originalRoomyId = repo.getRoomyId(spaceDid, "message", originalMsgId);
		if (!originalRoomyId) {
			log.debug(
				`Original message ${originalMsgId} not synced to ${spaceDid}, skipping forward`,
			);
			writeSkipRecord(
				"thread_starter_no_original",
				message,
				`original ${originalMsgId} in ${spaceDid}`,
			);
			continue;
		}

		const fromRoomId = repo.getRoomyId(spaceDid, "channel", parentChannelId);
		if (!fromRoomId) {
			log.debug(
				`No Roomy room for parent channel ${parentChannelId} in ${spaceDid}, skipping forward`,
			);
			writeSkipRecord(
				"thread_starter_no_parent",
				message,
				`parent ${parentChannelId} in ${spaceDid}`,
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

			// Store with a composite key so the Roomy→Discord router can dedupe
			// this forward event against its per-message forward key.
			repo.registerMapping(
				spaceDid,
				"message",
				messageId,
				`${forwardUlid}:${originalRoomyId}`,
			);

			log.info(
				`Forwarded original message ${originalMsgId} to thread ${threadId} in ${spaceDid}`,
			);
			synced++;
		} catch (err) {
			log.error(
				`Failed to forward message to thread ${threadId} in ${spaceDid}`,
				err,
			);
			writeSkipRecord("thread_starter_send_failed", message, spaceDid);
		}
	}

	return { synced, skipped: targetSpaces.length - synced };
}

/**
 * Handle a Discord forwarded message: forward the original message into the
 * target channel's Roomy room.
 *
 * Discord represents a forward as an ordinary DEFAULT message (type 0)
 * carrying the HAS_SNAPSHOT flag (1 << 14) and a `messageSnapshots` array,
 * whose `messageReference` points at the original message (in the source
 * channel). `message.channelId` is the channel the user forwarded into. We
 * mirror this to Roomy with a `forwardMessages.v0` event targeting the
 * destination room.
 */
async function handleForwardMessage(
	message: DiscordMessageData,
	repo: BridgeRepository,
	roomy: RoomyGateway,
): Promise<{ synced: number; skipped: number }> {
	const targetChannelId = message.channelId;
	const messageId = message.id;
	const guildId = message.guildId;

	if (
		!guildId ||
		!message.messageReference?.messageId ||
		!message.messageReference?.channelId
	) {
		writeSkipRecord("forward_missing_ref", message);
		return { synced: 0, skipped: 1 };
	}

	const originalMsgId = message.messageReference.messageId;
	const sourceChannelId = message.messageReference.channelId;

	const targetSpaces = repo.getTargetSpacesForChannel(guildId, targetChannelId);
	if (targetSpaces.length === 0) {
		log.debug(
			`Skipping forward ${messageId}: channel ${targetChannelId} not bridged`,
		);
		writeSkipRecord(
			"forward_not_bridged",
			message,
			`channel ${targetChannelId}`,
		);
		return { synced: 0, skipped: 1 };
	}

	let synced = 0;

	for (const spaceDid of targetSpaces) {
		const existing = repo.getRoomyId(spaceDid, "message", messageId);
		if (existing) {
			log.debug(`Skipping forward ${messageId}: already synced to ${spaceDid}`);
			writeSkipRecord("forward_already_synced", message, spaceDid);
			continue;
		}

		// Capacity enforcement: halt sync for this space while the bridged
		// guild is over the space's member capacity.
		if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
			log.warn(
				`capacity: sync halted for ${spaceDid} (guild ${guildId}); skipping forward ${messageId}`,
				{ guildId, spaceDid, messageId },
			);
			writeSkipRecord("capacity_over_limit", message, spaceDid);
			continue;
		}

		const targetRoomyRoom = repo.getRoomyRoomId(spaceDid, targetChannelId);
		if (!targetRoomyRoom) {
			log.debug(
				`No Roomy room for target channel ${targetChannelId} in ${spaceDid}, skipping forward`,
			);
			writeSkipRecord(
				"forward_no_target_room",
				message,
				`channel ${targetChannelId} in ${spaceDid}`,
			);
			continue;
		}

		const originalRoomyId = repo.getRoomyId(spaceDid, "message", originalMsgId);
		if (!originalRoomyId) {
			log.debug(
				`Original message ${originalMsgId} not synced to ${spaceDid}, skipping forward`,
			);
			writeSkipRecord(
				"forward_no_original",
				message,
				`original ${originalMsgId} in ${spaceDid}`,
			);
			continue;
		}

		const sourceRoomyRoom = repo.getRoomyRoomId(spaceDid, sourceChannelId);
		if (!sourceRoomyRoom) {
			log.debug(
				`No Roomy room for source channel ${sourceChannelId} in ${spaceDid}, skipping forward`,
			);
			writeSkipRecord(
				"forward_no_source_room",
				message,
				`source ${sourceChannelId} in ${spaceDid}`,
			);
			continue;
		}

		const forwardUlid = newUlid();
		const forwardEvent: Event = {
			id: forwardUlid,
			room: Ulid.assert(targetRoomyRoom),
			$type: "space.roomy.message.forwardMessages.v0",
			messageIds: [Ulid.assert(originalRoomyId)],
			fromRoomId: Ulid.assert(sourceRoomyRoom),
		};

		try {
			await roomy.sendEvent(spaceDid, forwardEvent);

			// Store with a composite key so the Roomy→Discord router can dedupe
			// this forward event against its per-message forward key.
			repo.registerMapping(
				spaceDid,
				"message",
				messageId,
				`${forwardUlid}:${originalRoomyId}`,
			);

			log.info(
				`Forwarded original message ${originalMsgId} to channel ${targetChannelId} in ${spaceDid}`,
			);
			synced++;
		} catch (err) {
			log.error(
				`Failed to forward message to channel ${targetChannelId} in ${spaceDid}`,
				err,
			);
			writeSkipRecord("forward_send_failed", message, spaceDid);
		}
	}

	return { synced, skipped: targetSpaces.length - synced };
}
