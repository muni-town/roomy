import { type Event, newUlid, Ulid } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { DiscordChannelData } from "../discord/data.ts";
import {
	CHANNEL_TYPES,
	isChannelPublic,
	mappingKindForChannel,
	PRIVATE_THREAD,
	THREAD_TYPES,
} from "../discord/data.ts";
import { createLogger } from "../logger.ts";
import { getCapacityGate } from "../roomy/capacity.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";

const log = createLogger("room");

/**
 * Ensure a Roomy room exists for a Discord channel in the given spaces.
 * Skips spaces that already have a mapping. Idempotent per space.
 */
export async function ensureRoomyChannel(
	repo: BridgeRepository,
	roomy: RoomyGateway,
	channelId: string,
	guildId: string,
	channelName: string,
	targetSpaces: string[],
	defaultAccess: "read" | "none" = "read",
): Promise<void> {
	for (const spaceDid of targetSpaces) {
		if (repo.getRoomyId(spaceDid, "channel", channelId)) {
			log.debug(`Channel ${channelId} already synced to ${spaceDid}`);
			continue;
		}

		// Capacity enforcement: halt room creation for this space while the
		// bridged guild is over the space's member capacity.
		if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
			log.warn(
				`capacity: sync halted for ${spaceDid} (guild ${guildId}); skipping room creation for channel ${channelId}`,
				{ guildId, spaceDid, channelId },
			);
			continue;
		}

		const roomUlid = newUlid();
		const event: Event = {
			id: roomUlid,
			$type: "space.roomy.room.createRoom.v0",
			kind: "space.roomy.channel",
			name: channelName,
			defaultAccess,
			extensions: {
				"space.roomy.extension.discordOrigin.v0": {
					snowflake: channelId,
					guildId,
				},
			},
		};

		try {
			await roomy.sendEvent(spaceDid, event);
			repo.registerMapping(spaceDid, "channel", channelId, roomUlid);
			log.info(
				`Created Roomy room ${roomUlid} for Discord channel ${channelId} in ${spaceDid}`,
			);
		} catch (err) {
			log.error(
				`Failed to create Roomy room for channel ${channelId} in ${spaceDid}`,
				err,
			);
		}
	}
}

/**
 * Handle Discord CHANNEL_CREATE: create a Roomy room for the new channel
 * in every space that bridges this guild in `full` mode. Subset bridges are
 * skipped — the channel must be added to their allowlist explicitly.
 */
export async function handleChannelCreate(
	channel: DiscordChannelData,
	repo: BridgeRepository,
	roomy: RoomyGateway,
): Promise<void> {
	const channelId = channel.id;
	const guildId = channel.guildId;

	if (!guildId) return;
	// Defense-in-depth: also exclude thread types explicitly.
	if (!CHANNEL_TYPES.has(channel.type) || THREAD_TYPES.has(channel.type))
		return;

	const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);

	// Determine access level based on whether the channel is public or private.
	const isPublic = isChannelPublic(channel, guildId);
	const defaultAccess: "read" | "none" = isPublic ? "read" : "none";

	if (targetSpaces.length === 0) {
		log.debug(`Skipping channel ${channelId}: no bridges target it`);
		return;
	}

	const channelName = channel.name;
	if (!channelName) {
		log.error(`Channel ${channelId} has no name; skipping create`);
		return;
	}

	await ensureRoomyChannel(
		repo,
		roomy,
		channelId,
		guildId,
		channelName,
		targetSpaces,
		defaultAccess,
	);
}

/**
 * Handle Discord THREAD_CREATE: create a Roomy thread linked to the parent
 * channel's room. Idempotent — skips if the thread already has a mapping.
 *
 * Echo prevention: when the bridge creates a Discord thread from a Roomy
 * thread (Roomy→Discord direction), Discord sets the thread's `owner_id`
 * to the bot's own user ID and fires a `THREAD_CREATE` gateway event for it.
 * The REST response that gave us the thread ID and the gateway event are
 * independent async paths, so the thread→Roomy mapping registered by the
 * router may not yet be visible when this handler runs — the dedup check
 * below would miss it and we'd create a *second* Roomy thread for the same
 * Discord thread. Checking `ownerId === botUserId` is deterministic and
 * timing-independent, mirroring the `isOurWebhook` approach used for
 * webhook messages in message-ingestion.
 */
export async function handleThreadCreate(
	channel: DiscordChannelData,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	botUserId?: string,
): Promise<void> {
	const threadId = channel.id;
	const parentId = channel.parentId;
	const guildId = channel.guildId;
	const threadName = channel.name ?? "Thread";

	if (!parentId || !guildId) {
		log.debug(`Skipping thread ${threadId}: no parentId or guildId`);
		return;
	}

	// Skip threads created by this bridge (echo prevention). Discord sets a
	// thread's owner_id to the bot user when the bot starts the thread.
	if (botUserId && channel.ownerId && channel.ownerId === botUserId) {
		log.debug(
			`Skipping thread ${threadId}: created by this bridge (ownerId=${channel.ownerId})`,
		);
		return;
	}

	// Private threads are synced with defaultAccess=none so only admins can see them.
	const defaultAccess: "read" | "none" | undefined =
		channel.type === PRIVATE_THREAD ? "none" : undefined;

	const targetSpaces = repo.getTargetSpacesForChannel(guildId, parentId);
	if (targetSpaces.length === 0) {
		log.debug(
			`Skipping thread ${threadId}: parent channel ${parentId} not bridged`,
		);
		return;
	}

	for (const spaceDid of targetSpaces) {
		if (repo.getRoomyId(spaceDid, "thread", threadId)) {
			log.debug(`Thread ${threadId} already synced to ${spaceDid}`);
			continue;
		}

		// Capacity enforcement: halt thread creation for this space while the
		// bridged guild is over the space's member capacity.
		if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
			log.warn(
				`capacity: sync halted for ${spaceDid} (guild ${guildId}); skipping thread creation for ${threadId}`,
				{ guildId, spaceDid, threadId },
			);
			continue;
		}

		const parentRoomyId = repo.getRoomyId(spaceDid, "channel", parentId);
		if (!parentRoomyId) {
			log.warn(
				`No Roomy room for parent channel ${parentId} in ${spaceDid}, skipping thread`,
			);
			continue;
		}

		const threadUlid = newUlid();
		const linkUlid = newUlid();

		const events: Event[] = [
			{
				id: threadUlid,
				$type: "space.roomy.room.createRoom.v0",
				kind: "space.roomy.thread",
				name: threadName,
				defaultAccess,
				extensions: {
					"space.roomy.extension.discordOrigin.v0": {
						snowflake: threadId,
						guildId,
					},
				},
			},
			{
				id: linkUlid,
				room: Ulid.assert(parentRoomyId),
				$type: "space.roomy.link.createRoomLink.v0",
				linkToRoom: threadUlid,
				isCreationLink: true,
			},
		];

		try {
			await roomy.sendEvents(spaceDid, events);

			repo.registerMapping(spaceDid, "thread", threadId, threadUlid);

			// Auto-add thread to allowlist for subset mode bridges
			const config = repo.getBridgeConfig(guildId, spaceDid);
			if (config?.mode === "subset") {
				repo.addToAllowlist(spaceDid, threadId, guildId);
			}

			log.info(
				`Created Roomy thread ${threadUlid} for Discord thread ${threadId} in ${spaceDid}`,
			);
		} catch (err) {
			log.error(
				`Failed to create Roomy thread for ${threadId} in ${spaceDid}`,
				err,
			);
		}
	}
}

/**
 * Handle Discord CHANNEL_UPDATE / THREAD_UPDATE: propagate name changes to
 * the corresponding Roomy room.
 */
export async function handleRoomUpdate(
	channel: DiscordChannelData,
	repo: BridgeRepository,
	roomy: RoomyGateway,
): Promise<void> {
	const channelId = channel.id;
	const guildId = channel.guildId;

	if (!guildId) return;
	if (!channel.name) return;

	const kind = mappingKindForChannel(channel);

	const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
	if (targetSpaces.length === 0) return;

	for (const spaceDid of targetSpaces) {
		const roomyId = repo.getRoomyId(spaceDid, kind, channelId);
		if (!roomyId) {
			log.debug(`No Roomy room mapped for ${kind} ${channelId} in ${spaceDid}`);
			continue;
		}

		const event: Event = {
			id: newUlid(),
			$type: "space.roomy.room.updateRoom.v0",
			roomId: Ulid.assert(roomyId),
			name: channel.name,
		};

		try {
			await roomy.sendEvent(spaceDid, event);
			log.info(
				`Updated Roomy ${kind} ${roomyId} name to "${channel.name}" in ${spaceDid}`,
			);
		} catch (err) {
			log.error(
				`Failed to update Roomy ${kind} ${roomyId} in ${spaceDid}`,
				err,
			);
		}
	}
}

/**
 * Handle Discord CHANNEL_DELETE / THREAD_DELETE: soft-delete the corresponding
 * Roomy room and drop the snowflake → ULID mapping.
 */
export async function handleRoomDelete(
	channel: DiscordChannelData,
	repo: BridgeRepository,
	roomy: RoomyGateway,
): Promise<void> {
	const channelId = channel.id;
	const guildId = channel.guildId;
	if (!guildId) return;

	const kind = mappingKindForChannel(channel);

	const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
	if (targetSpaces.length === 0) return;

	for (const spaceDid of targetSpaces) {
		const roomyId = repo.getRoomyId(spaceDid, kind, channelId);
		if (!roomyId) continue;

		const event: Event = {
			id: newUlid(),
			$type: "space.roomy.room.deleteRoom.v0",
			roomId: Ulid.assert(roomyId),
		};

		try {
			await roomy.sendEvent(spaceDid, event);
			repo.unregisterMapping(spaceDid, kind, channelId);
			log.info(
				`Deleted Roomy ${kind} ${roomyId} for Discord channel ${channelId} in ${spaceDid}`,
			);
		} catch (err) {
			log.error(
				`Failed to delete Roomy ${kind} ${roomyId} in ${spaceDid}`,
				err,
			);
		}
	}
}
