import { type Event, newUlid, Ulid } from "@roomy-space/sdk";
import type {
	BridgeConfig,
	BridgeMode,
	BridgeRepository,
} from "../db/repository.ts";
import {
	CHANNEL_TYPES,
	isChannelPublic,
	MESSAGE_CHANNEL_TYPES,
	PRIVATE_THREAD,
	THREAD_TYPES,
} from "../discord/data.ts";
import type { DiscordDataSource } from "../discord/data-source.ts";
import { createLogger } from "../logger.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import { ingestDiscordMessage } from "./message-ingestion.ts";
import { ensureRoomyChannel } from "./room-sync.ts";

const log = createLogger("backfill");

const activeBackfills = new Set<string>();

/** Sleep for a given number of milliseconds. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBackfill(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
): Promise<void> {
	log.info("Starting history backfill...");

	const configs = repo.listAllBridgeConfigs();
	if (configs.length === 0) {
		log.info("No bridge configs found, skipping backfill");
		return;
	}

	// Ensure Roomy rooms exist for all bridged channels before backfilling.
	try {
		await ensureRoomyRooms(discord, repo, roomy, configs);
	} catch (err) {
		log.error("ensureRoomyRooms failed", err);
	}
	try {
		await ensureRoomyThreads(discord, repo, roomy, configs);
	} catch (err) {
		log.error("ensureRoomyThreads failed", err);
	}

	// Backfill is per (channel, space) — each pair has its own cursor.
	const tasks: Array<{ channelId: string; spaceDid: string }> = [];
	for (const config of configs) {
		const channelIds = await channelsForConfig(discord, repo, config);
		for (const channelId of channelIds) {
			tasks.push({ channelId, spaceDid: config.spaceDid });
		}
	}

	if (tasks.length === 0) {
		log.info("No channels to backfill");
		return;
	}

	log.info(`Backfilling ${tasks.length} (channel, space) pairs`);

	const results = await Promise.allSettled(
		tasks.map((t) =>
			backfillChannel(discord, repo, roomy, t.channelId, t.spaceDid),
		),
	);

	const succeeded = results.filter((r) => r.status === "fulfilled").length;
	const failed = results.filter((r) => r.status === "rejected").length;
	log.info(`Backfill complete: ${succeeded} succeeded, ${failed} failed`);

	// Deprioritized: fetch public archived threads and backfill.
	try {
		await ensureAndBackfillArchivedThreads(discord, repo, roomy, configs);
	} catch (err) {
		log.error("ensureAndBackfillArchivedThreads failed", err);
	}
}

async function ensureRoomyRooms(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	configs: BridgeConfig[],
): Promise<void> {
	for (const config of configs) {
		try {
			const { guildId, spaceDid, mode } = config;
			let channelIds: string[];

			if (mode === "full") {
				const guild = await discord.getGuild(guildId);
				if (!guild?.channels) continue;
				channelIds = guild.channels
					.filter((ch) => CHANNEL_TYPES.has(ch.type))
					.map((ch) => ch.id);
			} else {
				const guild = await discord.getGuild(guildId);
				const guildChannels = guild?.channels ?? [];
				channelIds = [];
				for (const entry of repo.listAllowlistForBridge(spaceDid)) {
					const cachedCh = guildChannels.find(
						(ch) => ch.id === entry.channelId,
					);
					if (cachedCh) {
						if (CHANNEL_TYPES.has(cachedCh.type)) {
							channelIds.push(entry.channelId);
						}
						continue;
					}
					// Channel not in guild — resolve type via data source
					const chType = await discord.resolveChannelType(entry.channelId);
					if (chType !== undefined && CHANNEL_TYPES.has(chType)) {
						channelIds.push(entry.channelId);
					} else {
						log.debug(
							`Skipping allowlist entry ${entry.channelId}: resolved type ${chType} is not a top-level channel`,
						);
					}
				}
			}

			let created = 0;

			for (const channelId of channelIds) {
				try {
					if (repo.getRoomyId(spaceDid, "channel", channelId)) continue;

					const channelName = await discord.resolveChannelName(channelId);
					if (!channelName) {
						log.error(
							`Cannot resolve name for Discord channel ${channelId} in guild ${guildId}; skipping room creation`,
						);
						continue;
					}

					const roomUlid = newUlid();

					// Determine default access: "none" for private channels, "read" for public.
					const channel = await discord.getChannel(channelId);
					const defaultAccess: "read" | "none" =
						channel && !isChannelPublic(channel, guildId) ? "none" : "read";

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

					await roomy.sendEvent(spaceDid, event);
					repo.registerMapping(spaceDid, "channel", channelId, roomUlid);
					created++;
				} catch (err) {
					log.error(
						`Failed to create Roomy room for channel ${channelId} in ${spaceDid}`,
						err,
					);
				}
			}

			if (created > 0) {
				log.info(
					`Created ${created} Roomy rooms for ${channelIds.length} bridged channels in ${spaceDid}`,
				);
			}
		} catch (err) {
			log.error(
				`Failed to ensure Roomy rooms for space ${config.spaceDid}`,
				err,
			);
		}
	}
}

async function ensureRoomyThreads(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	configs: BridgeConfig[],
): Promise<void> {
	for (const config of configs) {
		try {
			const { guildId, spaceDid, mode } = config;

			const guild = await discord.getGuild(guildId);
			if (!guild?.channels) continue;

			// Discover threads that belong to bridged channels.
			const bridgedChannelIds: Set<string> =
				mode === "full"
					? new Set(
							guild.channels
								.filter((ch) => CHANNEL_TYPES.has(ch.type))
								.map((ch) => ch.id),
						)
					: new Set(
							repo.listAllowlistForBridge(spaceDid).map((e) => e.channelId),
						);

			const threads = guild.channels.filter(
				(ch) =>
					THREAD_TYPES.has(ch.type) &&
					ch.type !== PRIVATE_THREAD &&
					ch.parentId &&
					bridgedChannelIds.has(ch.parentId),
			);

			if (threads.length === 0) continue;

			let created = 0;

			for (const thread of threads) {
				try {
					const threadId = thread.id;
					if (repo.getRoomyId(spaceDid, "thread", threadId)) continue;

					const parentId = thread.parentId;
					if (!parentId) continue;
					const parentRoomyId = repo.getRoomyId(spaceDid, "channel", parentId);
					if (!parentRoomyId) {
						log.warn(
							`Parent channel ${parentId} not bridged in ${spaceDid}; skipping thread ${threadId}`,
						);
						continue;
					}

					if (!thread.name) {
						log.error(
							`Cannot resolve name for Discord thread ${threadId} in guild ${guildId}; skipping`,
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
							name: thread.name,
							defaultAccess: "read",
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

					await roomy.sendEvents(spaceDid, events);
					repo.registerMapping(spaceDid, "thread", threadId, threadUlid);

					if (mode === "subset") {
						repo.addToAllowlist(spaceDid, threadId, guildId);
					}

					created++;
				} catch (err) {
					log.error(
						`Failed to create Roomy thread for ${thread.id} in ${spaceDid}`,
						err,
					);
				}
			}

			if (created > 0) {
				log.info(`Created ${created} Roomy threads in ${spaceDid}`);
			}
		} catch (err) {
			log.error(
				`Failed to ensure Roomy threads for space ${config.spaceDid}`,
				err,
			);
		}
	}
}

async function channelsForConfig(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	config: { guildId: string; spaceDid: string; mode: BridgeMode },
): Promise<string[]> {
	const channels: string[] = [];

	if (config.mode === "full") {
		const guild = await discord.getGuild(config.guildId);
		if (!guild) {
			log.warn(`Guild ${config.guildId} not found, skipping`);
			return channels;
		}
		if (!guild.channels) return channels;
		for (const channel of guild.channels) {
			if (MESSAGE_CHANNEL_TYPES.has(channel.type)) {
				channels.push(channel.id);
			}
		}
	} else {
		const allowlist = repo.listAllowlistForBridge(config.spaceDid);
		for (const entry of allowlist) {
			channels.push(entry.channelId);
		}
	}

	return channels;
}

export async function backfillSingleChannel(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	channelId: string,
	guildId?: string,
): Promise<void> {
	// Ensure Roomy room exists for this channel in all relevant spaces
	if (guildId) {
		// Type guard: skip threads — they have their own creation path.
		const cachedChannel = await discord.getChannel(channelId);
		if (cachedChannel && THREAD_TYPES.has(cachedChannel.type)) {
			log.debug(
				`backfillSingleChannel: channel ${channelId} is a thread (type ${cachedChannel.type}); skipping channel-kind creation`,
			);
			return;
		}
		// Cache miss or unknown type — resolve via data source
		if (!cachedChannel) {
			const chType = await discord.resolveChannelType(channelId);
			if (chType !== undefined && !CHANNEL_TYPES.has(chType)) {
				log.debug(
					`backfillSingleChannel: channel ${channelId} resolved to type ${chType} (not a top-level channel); skipping channel-kind creation`,
				);
				return;
			}
		}

		const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
		const channelName = await discord.resolveChannelName(channelId);
		if (channelName) {
			await ensureRoomyChannel(
				repo,
				roomy,
				channelId,
				guildId,
				channelName,
				targetSpaces,
			);
		}
	}

	// Backfill into each bridged space for this channel.
	if (guildId) {
		const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
		for (const spaceDid of targetSpaces) {
			await backfillChannel(discord, repo, roomy, channelId, spaceDid);
		}
	}
}

export async function backfillChannel(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	channelId: string,
	spaceDid: string,
	guildIdOverride?: string,
): Promise<void> {
	const key = `${channelId}:${spaceDid}`;
	if (activeBackfills.has(key)) {
		log.debug(`Skipping backfill for ${key}: already in progress`);
		return;
	}
	activeBackfills.add(key);

	try {
		const guildId =
			guildIdOverride ?? (await discord.resolveGuildIdForChannel(channelId));
		if (!guildId) {
			log.error(
				`Cannot resolve guildId for channel ${channelId}; skipping backfill`,
			);
			return;
		}

		const cursor = repo.getChannelCursor(spaceDid, channelId);
		// First-time backfill: start from the channel snowflake (which is older
		// than any message in the channel). Resume: start from last cursor.
		let afterCursor = cursor?.lastMessageId ?? channelId;

		log.info(
			`Backfilling channel ${channelId} → ${spaceDid} (cursor: ${cursor?.lastMessageId ?? "none"})`,
		);

		let totalSynced = 0;
		let totalSkipped = 0;

		while (true) {
			const messages = await discord.getMessages(channelId, {
				after: afterCursor,
				limit: 100,
			});

			if (messages.length === 0) break;

			// Discord API returns newest-first regardless of pagination direction.
			// Reverse so we process oldest-first, preserving chronological order.
			const sortedMessages = [...messages].reverse();

			for (const message of sortedMessages) {
				try {
					const result = await ingestDiscordMessage(
						message,
						repo,
						roomy,
						guildId,
						spaceDid,
						(snowflake) => discord.resolveChannelName(snowflake),
						true, // backfill — skips per-message cursor writes
					);
					totalSynced += result.synced;
					totalSkipped += result.skipped;
				} catch (err) {
					log.error(
						`Error processing message in backfill for channel ${channelId}`,
						err,
					);
				}
			}

			// Advance cursor at page boundary (not per-message) so a crash in
			// the middle of a page doesn't lose the unprocessed messages.
			const lastMessage = sortedMessages.at(-1);
			if (!lastMessage) break;
			const oldestInBatch = lastMessage;
			afterCursor = oldestInBatch.id;
			repo.setChannelCursor(spaceDid, channelId, afterCursor);

			if (messages.length < 100) break;
		}

		log.info(
			`Channel ${channelId} → ${spaceDid} backfill done: ${totalSynced} synced, ${totalSkipped} skipped`,
		);
	} finally {
		activeBackfills.delete(key);
	}
}

/**
 * Fetch public archived threads for all bridged parent channels, create Roomy
 * rooms for any that aren't yet mapped, and backfill their messages.
 */
async function ensureAndBackfillArchivedThreads(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	configs: BridgeConfig[],
): Promise<void> {
	log.info("Starting archived thread backfill...");

	const CHANNEL_DELAY_MS = 1_000;
	const BACKFILL_DELAY_MS = 500;
	let totalThreads = 0;

	for (const config of configs) {
		try {
			const { guildId, spaceDid, mode } = config;
			const guild = await discord.getGuild(guildId);
			if (!guild?.channels) continue;

			// Determine bridged parent channels (same logic as ensureRoomyThreads).
			const bridgedParentChannels =
				mode === "full"
					? guild.channels.filter((ch) => CHANNEL_TYPES.has(ch.type))
					: guild.channels.filter((ch) => {
							if (!CHANNEL_TYPES.has(ch.type)) return false;
							return repo
								.listAllowlistForBridge(spaceDid)
								.some((e) => e.channelId === ch.id);
						});

			if (bridgedParentChannels.length === 0) continue;

			let parentChannelsProcessed = 0;

			for (const parentChannel of bridgedParentChannels) {
				try {
					const parentChannelId = parentChannel.id;
					const parentRoomyId = repo.getRoomyId(
						spaceDid,
						"channel",
						parentChannelId,
					);
					if (!parentRoomyId) continue;

					let cursor: string | undefined;
					let hasMore = true;

					while (hasMore) {
						const opts: { before?: string; limit: number } = { limit: 100 };
						if (cursor) {
							opts.before = cursor;
						}

						const result = await discord.getPublicArchivedThreads(
							parentChannelId,
							opts,
						);

						if (!result.threads?.length) break;

						for (const thread of result.threads) {
							const threadId = thread.id;
							if (repo.getRoomyId(spaceDid, "thread", threadId)) continue;
							if (!thread.name) continue;

							// Create Roomy room + parent link (same pattern as ensureRoomyThreads)
							const threadUlid = newUlid();
							const linkUlid = newUlid();

							const events: Event[] = [
								{
									id: threadUlid,
									$type: "space.roomy.room.createRoom.v0",
									kind: "space.roomy.thread",
									name: thread.name,
									defaultAccess: "read",
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

							await roomy.sendEvents(spaceDid, events);
							repo.registerMapping(spaceDid, "thread", threadId, threadUlid);

							if (mode === "subset") {
								repo.addToAllowlist(spaceDid, threadId, guildId);
							}

							totalThreads++;

							// Backfill this archived thread's messages
							await backfillChannel(
								discord,
								repo,
								roomy,
								threadId,
								spaceDid,
								guildId,
							);

							await delay(BACKFILL_DELAY_MS);
						}

						hasMore = result.hasMore ?? false;
						if (result.threads.length > 0) {
							cursor = result.threads[result.threads.length - 1]?.id;
						} else {
							break;
						}
					}

					parentChannelsProcessed++;

					if (parentChannelsProcessed < bridgedParentChannels.length) {
						await delay(CHANNEL_DELAY_MS);
					}
				} catch (err) {
					log.error(
						`Failed to backfill archived threads for parent channel ${parentChannel.id} in ${spaceDid}`,
						err,
					);
				}
			}

			log.info(
				`Archived thread backfill for ${spaceDid}: processed ${totalThreads} threads across ${parentChannelsProcessed} parent channels`,
			);
		} catch (err) {
			log.error(
				`Failed to backfill archived threads for space ${config.spaceDid}`,
				err,
			);
		}
	}

	log.info("Archived thread backfill complete");
}
