import {
	Did,
	type Event,
	newUlid,
	serializeBlocks,
	toBytes,
	Ulid,
} from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { DiscordMessageData } from "../discord/data.ts";
import { createLogger } from "../logger.ts";
import { getCapacityGate } from "../roomy/capacity.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import {
	type MentionContext,
	resolveMentionsToBlocks,
} from "./mention-resolver.ts";
import { buildRoomyRoomIds } from "./message-ingestion.ts";
import { syncUserProfile } from "./profile-sync.ts";
import { sendEventOrQueue } from "./send-retry.ts";

const log = createLogger("edit-delete");

export async function handleMessageEdit(
	message: DiscordMessageData,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	resolveChannelName?: (snowflake: string) => Promise<string | undefined>,
): Promise<void> {
	const messageId = message.id;
	const channelId = message.channelId;

	// Only process actual user edits (not embed updates)
	if (!message.editedTimestamp) return;

	const guildId = message.guildId;
	if (!guildId) return;

	// Echo prevention: skip edits of messages sent by this bridge's webhook.
	// The webhook REST response and the MESSAGE_UPDATE gateway event are
	// independent async paths, so the mapping registered by the router may
	// not have completed before the gateway event arrives. Checking against
	// our stored webhook IDs is deterministic and doesn't depend on timing,
	// mirroring the same guard in ingestDiscordMessage.
	if (message.webhookId && repo.isOurWebhook(message.webhookId)) {
		log.debug(`Skipping edit of own webhook message ${messageId}`);
		return;
	}

	const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
	if (targetSpaces.length === 0) return;

	// Pre-resolve channel/thread names from mentionChannelIds AND a content scan
	// for `<#id>` (with REST fallback). Discord omits threads from
	// mentionChannelIds, so an edited thread mention would otherwise fall back
	// to the raw snowflake text — mirror the create path (message-ingestion.ts)
	// which scans the content to guarantee every bridged reference resolves.
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

	for (const spaceDid of targetSpaces) {
		const roomyMessageId = repo.getRoomyId(spaceDid, "message", messageId);
		if (!roomyMessageId) {
			log.debug(
				`Skipping edit for ${messageId}: no Roomy mapping in ${spaceDid}`,
			);
			continue;
		}

		// Capacity enforcement: halt sync for this space while the bridged
		// guild is over the space's member capacity.
		if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
			log.warn(
				`capacity: sync halted for ${spaceDid} (guild ${guildId}); skipping edit for message ${messageId}`,
				{ guildId, spaceDid, messageId },
			);
			continue;
		}

		const roomyRoomId = repo.getRoomyRoomId(spaceDid, channelId);
		if (!roomyRoomId) {
			log.warn(
				`No Roomy room for channel ${channelId} in ${spaceDid}, skipping edit`,
			);
			continue;
		}

		// Sync author profile before edit
		await syncUserProfile(message.author, [spaceDid], repo, roomy, guildId);

		const eventUlid = newUlid();

		// Resolve Discord mention syntax into clean Markdown (per-space, so
		// channel mentions resolve to the correct Roomy room ULID). Build the
		// room map from the content's <#id> references so bridged thread/channel
		// mentions always get a link even if the display name can't be resolved.
		const roomyRoomIds = buildRoomyRoomIds(
			message.content || "",
			repo,
			spaceDid,
		);
		const mentionCtx: MentionContext = { channelNames, roomyRoomIds };
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
		};

		const event: Event = {
			id: eventUlid,
			room: Ulid.assert(roomyRoomId),
			$type: "space.roomy.message.editMessage.v0",
			messageId: Ulid.assert(roomyMessageId),
			body: {
				mimeType: serializedBody.mimeType,
				data: toBytes(serializedBody.data),
			},
			extensions,
		};

		const landed = await sendEventOrQueue(repo, roomy, {
			spaceDid,
			op: "message_edit",
			discordId: messageId,
			events: [event],
			mapping: null,
		});
		if (landed) {
			log.info(
				`Synced edit for message ${messageId} → ${roomyMessageId} in ${spaceDid}`,
			);
		}
	}
}

export async function handleMessageDelete(
	messageId: bigint,
	channelId: bigint,
	guildId: bigint | undefined,
	repo: BridgeRepository,
	roomy: RoomyGateway,
): Promise<void> {
	const messageIdStr = messageId.toString();
	const channelIdStr = channelId.toString();
	const guildIdStr = guildId?.toString();

	if (!guildIdStr) return;

	const targetSpaces = repo.getTargetSpacesForChannel(guildIdStr, channelIdStr);
	if (targetSpaces.length === 0) return;

	for (const spaceDid of targetSpaces) {
		const roomyMessageId = repo.getRoomyId(spaceDid, "message", messageIdStr);
		if (!roomyMessageId) {
			log.debug(
				`Skipping delete for ${messageIdStr}: no Roomy mapping in ${spaceDid}`,
			);
			continue;
		}

		const roomyRoomId = repo.getRoomyRoomId(spaceDid, channelIdStr);
		if (!roomyRoomId) {
			log.warn(
				`No Roomy room for channel ${channelIdStr} in ${spaceDid}, skipping delete`,
			);
			continue;
		}

		const eventUlid = newUlid();
		const extensions: Record<string, unknown> = {
			"space.roomy.extension.discordMessageOrigin.v0": {
				$type: "space.roomy.extension.discordMessageOrigin.v0",
				snowflake: messageIdStr,
				channelId: channelIdStr,
				guildId: guildIdStr,
			},
		};

		const event: Event = {
			id: eventUlid,
			room: Ulid.assert(roomyRoomId),
			$type: "space.roomy.message.deleteMessage.v0",
			messageId: Ulid.assert(roomyMessageId),
			extensions,
		};

		const landed = await sendEventOrQueue(repo, roomy, {
			spaceDid,
			op: "message_delete",
			discordId: messageIdStr,
			events: [event],
			mapping: null,
		});
		if (landed) {
			// Keep mapping row — delete is recorded; future edit attempts skip naturally
			log.info(
				`Synced delete for message ${messageIdStr} → ${roomyMessageId} in ${spaceDid}`,
			);
		}
	}
}
