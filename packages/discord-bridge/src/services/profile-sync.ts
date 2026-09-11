import { Did, type Event, newUlid } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { DiscordUserData } from "../discord/data.ts";
import { createLogger } from "../logger.ts";
import { getCapacityGate } from "../roomy/capacity.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import { computeProfileHash } from "../utils/hash.ts";

const log = createLogger("profile");

function discordAvatarUrl(
	userId: string,
	avatarHash: string | null,
	discriminator: string,
): string {
	if (avatarHash) {
		const ext = avatarHash.startsWith("a_") ? "gif" : "webp";
		return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=256`;
	}
	const mod = discriminator !== "0" ? parseInt(discriminator, 10) % 5 : 0;
	return `https://cdn.discordapp.com/embed/avatars/${mod}.png`;
}

/**
 * Sync a Discord user profile to Roomy for all target spaces.
 * Uses hash-based change detection to skip unchanged profiles.
 * On failure, enqueues the sync for retry with exponential backoff.
 */
export async function syncUserProfile(
	user: DiscordUserData,
	targetSpaces: string[],
	repo: BridgeRepository,
	roomy: RoomyGateway,
	guildId?: string,
): Promise<void> {
	const userIdStr = user.id;
	const avatarHash = user.avatar ?? null;
	const hash = computeProfileHash(
		user.name,
		user.globalName ?? null,
		avatarHash,
	);

	const avatar = discordAvatarUrl(userIdStr, avatarHash, user.discriminator);
	const handle =
		user.discriminator !== "0"
			? `${user.name}#${user.discriminator}`
			: user.name;

	for (const spaceDid of targetSpaces) {
		// Capacity enforcement: halt profile sync for this space while the
		// bridged guild is over the space's member capacity. Callers without
		// a guild context (none today) skip the gate.
		if (guildId && !(await getCapacityGate().isEnabled(guildId, spaceDid))) {
			log.warn(
				`capacity: sync halted for ${spaceDid} (guild ${guildId}); skipping profile sync for Discord user ${userIdStr}`,
				{ guildId, spaceDid, userId: userIdStr },
			);
			continue;
		}

		const existingHash = repo.getProfileHash(spaceDid, userIdStr);
		if (existingHash === hash) continue;

		const event: Event = {
			id: newUlid(),
			$type: "space.roomy.user.updateProfile.v0",
			did: Did.assert(`did:discord:${userIdStr}`),
			name: user.globalName ?? user.name,
			avatar,
			extensions: {
				"space.roomy.extension.discordUserOrigin.v0": {
					$type: "space.roomy.extension.discordUserOrigin.v0",
					snowflake: userIdStr,
					profileHash: hash,
					handle,
				},
			},
		};

		try {
			await roomy.sendEvent(spaceDid, event);
			repo.setProfileHash(spaceDid, userIdStr, hash);
			// Clear any stale retry entry on success
			repo.deleteProfileSyncEntry(spaceDid, userIdStr);
			// log.info(`Synced profile for Discord user ${userIdStr} to ${spaceDid}`);
		} catch (err) {
			log.error(
				`Failed to sync profile for Discord user ${userIdStr} to ${spaceDid}`,
				err,
			);
			// Enqueue for later retry with exponential backoff
			repo.enqueueProfileSync(
				spaceDid,
				userIdStr,
				user.name,
				user.globalName ?? null,
				avatarHash,
				user.discriminator,
			);
		}
	}
}

/**
 * Process the profile sync retry queue: drain all stale entries and attempt
 * each sync. Entries that succeed are removed; entries that fail again are
 * updated with bumped retry_count and next_retry_at.
 */
export async function retryStaleProfileSyncs(
	repo: BridgeRepository,
	roomy: RoomyGateway,
): Promise<void> {
	const stale = repo.getStaleProfileSyncEntries();
	if (stale.length === 0) return;

	log.info(`Processing ${stale.length} stale profile sync entries`);

	let succeeded = 0;
	for (const entry of stale) {
		// Capacity enforcement: skip retries for spaces whose every bridged
		// guild is over capacity (the retry queue has no guild context, so a
		// space is only skipped when all of its bridges are halted).
		const bridged = repo
			.listAllBridgeConfigs()
			.filter((c) => c.spaceDid === entry.spaceDid);
		if (bridged.length > 0) {
			const enabled = await Promise.all(
				bridged.map((c) =>
					getCapacityGate().isEnabled(c.guildId, c.spaceDid),
				),
			);
			if (!enabled.some(Boolean)) {
				log.warn(
					`capacity: sync halted for ${entry.spaceDid}; skipping profile sync retry for Discord user ${entry.discordUserId}`,
					{ spaceDid: entry.spaceDid, userId: entry.discordUserId },
				);
				continue;
			}
		}

		const hash = computeProfileHash(
			entry.username,
			entry.globalName,
			entry.avatarHash,
		);

		const existingHash = repo.getProfileHash(
			entry.spaceDid,
			entry.discordUserId,
		);
		// If the hash already matches, the profile is up to date — clear the queue.
		if (existingHash === hash) {
			repo.deleteProfileSyncEntry(entry.spaceDid, entry.discordUserId);
			succeeded++;
			continue;
		}

		const avatar = discordAvatarUrl(
			entry.discordUserId,
			entry.avatarHash,
			entry.discriminator,
		);
		const handle =
			entry.discriminator !== "0"
				? `${entry.username}#${entry.discriminator}`
				: entry.username;

		const event: Event = {
			id: newUlid(),
			$type: "space.roomy.user.updateProfile.v0",
			did: Did.assert(`did:discord:${entry.discordUserId}`),
			name: entry.globalName ?? entry.username,
			avatar,
			extensions: {
				"space.roomy.extension.discordUserOrigin.v0": {
					$type: "space.roomy.extension.discordUserOrigin.v0",
					snowflake: entry.discordUserId,
					profileHash: hash,
					handle,
				},
			},
		};

		try {
			await roomy.sendEvent(entry.spaceDid, event);
			repo.setProfileHash(entry.spaceDid, entry.discordUserId, hash);
			repo.deleteProfileSyncEntry(entry.spaceDid, entry.discordUserId);
			succeeded++;
			log.info(
				`Retried profile sync for Discord user ${entry.discordUserId} to ${entry.spaceDid} (attempt ${entry.retryCount + 1})`,
			);
		} catch (err) {
			log.error(
				`Retry failed for profile sync of user ${entry.discordUserId} to ${entry.spaceDid} (attempt ${entry.retryCount + 1})`,
				err,
			);
			// enqueueProfileSync bumps retry_count and updates next_retry_at
			repo.enqueueProfileSync(
				entry.spaceDid,
				entry.discordUserId,
				entry.username,
				entry.globalName,
				entry.avatarHash,
				entry.discriminator,
			);
		}
	}

	if (succeeded > 0) {
		log.info(
			`Retry sweep: ${succeeded}/${stale.length} profile syncs resolved`,
		);
	}
}
