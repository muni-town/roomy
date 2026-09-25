import { type Event, newUlid, Ulid } from "@roomy-space/sdk";
import type {
	BackfillProgress,
	BridgeConfig,
	BridgeMode,
	BridgeRepository,
} from "../db/repository.ts";
import type { DiscordSender } from "../discord/sender.ts";
import {
	CHANNEL_TYPES,
	isChannelPublic,
	mappingKindForChannel,
	MESSAGE_CHANNEL_TYPES,
	PRIVATE_THREAD,
	THREAD_TYPES,
} from "../discord/data.ts";
import type { DiscordDataSource } from "../discord/data-source.ts";
import { createLogger } from "../logger.ts";
import { BACKFILL_NOTICE_CHANNEL } from "../env.ts";
import { getCapacityGate } from "../roomy/capacity.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import { ingestDiscordMessage } from "./message-ingestion.ts";
import { ensureRoomyChannel, syncInitialStructure } from "./room-sync.ts";

const log = createLogger("backfill");

const activeBackfills = new Set<string>();

/**
 * Sender for the Discord-side backfill-completion notice. Set at
 * boot by index.ts; left undefined in unit tests unless a test installs a
 * sender. The notice is best-effort: failures are logged, never thrown, and
 * never fail the backfill itself.
 */
let noticeSender: DiscordSender | undefined;

/** Set the sender used for the Discord-side backfill-completion notice. */
export function setBackfillNoticeSender(sender: DiscordSender | undefined): void {
	noticeSender = sender;
}

/**
 * Spaces where the CURRENT runBackfill invocation did real work — a
 * (channel, space) pair crossed into `complete`, or thread rooms were
 * created. Reset at the start of each run, read once at the end of Phase 2
 * to decide which spaces get a completion notice. Without it, a restart over
 * an already-backfilled space would post a spurious "complete" notice.
 */
let runWorkSpaces = new Set<string>();

function markRunWork(spaceDid: string): void {
	runWorkSpaces.add(spaceDid);
}

/**
 * Whether a progress row reflects real ingested work — as opposed to a fresh
 * enumeration row that only marks the pair as known so the
 * status UI can list it up front. A row with no counts, no boundary, and no
 * walk cursor has never been backfilled: Phase 1 must still run its recent
 * window for it.
 */
function hasRealBackfillProgress(progress: BackfillProgress): boolean {
	return (
		progress.messagesSynced + progress.messagesSkipped > 0 ||
		progress.windowBoundary !== null ||
		progress.walkCursor !== null ||
		progress.phase === "complete"
	);
}

/**
 * Phase-1 bound: the most recent window backfilled first, in batches of
 * PHASE1_PAGE_SIZE, newest-first. The window stops once PHASE1_MESSAGE_BOUND
 * messages have been ingested for a (channel, space) pair, or when it reaches
 * the start of the channel's history (a short/empty page) — whichever comes
 * first. Falsifiable rule: Phase 1 ingests at most PHASE1_MESSAGE_BOUND
 * messages per (channel, space) pair; it marks the pair complete on the spot
 * when the whole history fit inside the bound.
 */
export const PHASE1_MESSAGE_BOUND = 1_000;
const PHASE1_PAGE_SIZE = 100;

/** True while the Phase-2 remainder walk is running in the background. */
let phase2Running = false;

/** True when a backfill (window or walk) is in flight for this pair. */
export function isBackfillRunning(spaceDid: string, channelId: string): boolean {
	return activeBackfills.has(`${channelId}:${spaceDid}`);
}

/** Sleep for a given number of milliseconds. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry budget + backoff for transient channel-resolution failures. */
const RESOLUTION_RETRY_ATTEMPTS = 3;
const RESOLUTION_RETRY_BASE_DELAY_MS = 500;

/**
 * Retry a channel-resolution call that signals failure by resolving to
 * undefined (REST-backed data sources swallow errors and return undefined).
 * Returns the first defined result, or undefined once the budget is spent,
 * so a transient lookup blip costs retry latency instead of a skipped
 * channel.
 */
async function resolveChannelFieldWithRetry<T>(
	resolve: () => Promise<T | undefined>,
): Promise<T | undefined> {
	for (let attempt = 1; attempt <= RESOLUTION_RETRY_ATTEMPTS; attempt++) {
		const result = await resolve();
		if (result !== undefined) return result;
		if (attempt < RESOLUTION_RETRY_ATTEMPTS) {
			await delay(RESOLUTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
		}
	}
	return undefined;
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

	// Reset the completion-notice work set: this run decides which spaces
	// get a notice once Phase 2 finishes.
	runWorkSpaces = new Set<string>();

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

	// One-shot: apply the guild's category structure + channel order to each
	// bridged space's sidebar. Runs HERE — on the initial-sync path (gateway
	// READY, /connect-roomy-space, /roomy-backfill) — and nowhere else. The
	// live channel handlers deliberately do not call it (see room-sync.ts),
	// so an ongoing Discord channel event cannot re-sync or re-order the
	// structure. `syncInitialStructure` additionally no-ops once the
	// (guild, space) marker is set, which covers a second backfill run and a
	// process restart. Ordered AFTER room creation so every bridged channel
	// already has its Roomy room id to place in a category.
	try {
		await syncInitialStructure(discord, repo, roomy, configs);
	} catch (err) {
		log.error("syncInitialStructure failed", err);
	}

	// Enumerate the full work set up front: create a progress row
	// for every bridged (channel, space) pair and active-thread pair so the
	// Roomy backfill-status panel can list everything immediately instead of
	// watching rows appear piecemeal as Phase 2 walks along. Rows that
	// already carry real progress are left untouched. Archived threads are
	// deliberately NOT enumerated here — they are discovered lazily in
	// Phase 2's deprioritized sweep.
	try {
		await enumerateBackfillWork(discord, repo, configs);
	} catch (err) {
		log.error("enumerateBackfillWork failed", err);
	}

	// Backfill is per (channel, space) — each pair has its own cursor.
	const tasks: Array<{ channelId: string; spaceDid: string; guildId: string }> =
		[];
	for (const config of configs) {
		// Capacity enforcement: skip configs whose bridged guild is over the
		// space's member capacity (backfill is the main cost driver).
		if (!(await getCapacityGate().isEnabled(config.guildId, config.spaceDid))) {
			log.warn(
				`capacity: backfill skipped for ${config.spaceDid} (guild ${config.guildId}): guild over space member capacity`,
				{ guildId: config.guildId, spaceDid: config.spaceDid },
			);
			continue;
		}
		const channelIds = await channelsForConfig(discord, repo, config);
		for (const channelId of channelIds) {
			tasks.push({ channelId, spaceDid: config.spaceDid, guildId: config.guildId });
		}
	}

	if (tasks.length === 0) {
		log.info("No channels to backfill");
		return;
	}

	log.info(`Backfilling ${tasks.length} (channel, space) pairs`);

	// ── Phase 1: bounded recent window, serial ───────────────────────────
	// For each pair with no durable progress yet, ingest the most recent
	// PHASE1_MESSAGE_BOUND messages so the space is immediately usable, then
	// let Phase 2 walk the rest in the background. Pairs that already have a
	// progress row or cursor (mid-walk, completed, interrupted) are left to
	// Phase 2 — re-running the window would redo work or reset the boundary
	// mid-flight. The per-pair guard in `activeBackfills` keeps this pass
	// from overlapping a running walk.
	for (const t of tasks) {
		const key = `${t.channelId}:${t.spaceDid}`;
		if (activeBackfills.has(key)) continue;
		const progress = repo.getBackfillProgress(t.spaceDid, t.channelId);
		const cursor = repo.getChannelCursor(t.spaceDid, t.channelId);
		if (cursor) continue;
		// Enumeration rows (zero real work) must still get their Phase-1
		// window; only rows with real progress are left to Phase 2.
		if (progress && hasRealBackfillProgress(progress)) continue;
		activeBackfills.add(key);
		try {
			await backfillRecentWindow(
				discord,
				repo,
				roomy,
				t.channelId,
				t.spaceDid,
				t.guildId,
				"channel",
			);
		} catch (reason) {
			log.error(
				`Phase-1 backfill failed for ${t.channelId} → ${t.spaceDid}`,
				reason,
			);
		} finally {
			activeBackfills.delete(key);
		}
	}

	// ── Phase 2: the remainder, in the background ────────────────────────
	// Resumable from the durable walk cursor, so a restart doesn't redo the
	// window or the already-walked pages.
	schedulePhase2(discord, repo, roomy, configs, tasks);
}

/**
 * Kick off the Phase-2 remainder walk in the background. Serial (one
 * (channel, space) pair at a time); after the top-level channels,
 * sweeps active threads the window may have truncated, then the
 * deprioritized archived-thread sweep.
 */
function schedulePhase2(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	configs: BridgeConfig[],
	phase1Tasks: Array<{
		channelId: string;
		spaceDid: string;
		guildId: string;
		parentId?: string | null;
	}>,
): void {
	if (phase2Running) {
		log.debug("Phase 2 already running; skipping duplicate schedule");
		return;
	}
	phase2Running = true;
	void (async () => {
		try {
			// Top-level channels (same enumeration as Phase 1), plus active
			// threads that are bridged — their recent window may have been
			// truncated at the bound too.
			const tasks = [...phase1Tasks];
			for (const config of configs) {
				if (
					!(await getCapacityGate().isEnabled(
						config.guildId,
						config.spaceDid,
					))
				) {
					continue;
				}
				try {
					const threads = await discord.getActiveThreads(config.guildId);
					for (const thread of threads) {
						if (!repo.getRoomyId(config.spaceDid, "thread", thread.id)) {
							continue;
						}
						tasks.push({
							channelId: thread.id,
							spaceDid: config.spaceDid,
							guildId: config.guildId,
							parentId: thread.parentId ?? null,
						});
					}
				} catch (err) {
					log.error(
						`Phase 2: failed to list active threads for ${config.spaceDid}`,
						err,
					);
				}
			}

			let succeeded = 0;
			let failed = 0;
			for (const t of tasks) {
				try {
					await backfillChannel(
						discord,
						repo,
						roomy,
						t.channelId,
						t.spaceDid,
						t.guildId,
						t.parentId,
					);
					succeeded++;
				} catch (reason) {
					failed++;
					log.error(
						`Phase-2 backfill failed for ${t.channelId} → ${t.spaceDid}`,
						reason,
					);
				}
			}
			log.info(
				`Phase-2 backfill complete: ${succeeded} succeeded, ${failed} failed`,
			);

			// Deprioritized: fetch public archived threads and backfill.
			try {
				await ensureAndBackfillArchivedThreads(discord, repo, roomy, configs);
			} catch (err) {
				log.error("ensureAndBackfillArchivedThreads failed", err);
			}

			// Discord-side completion notice: one message per
			// bridged space this run did work for, posted only now that all
			// phases (channels, active threads, archived threads) have
			// settled. Best-effort — never throws, never fails the walk.
			try {
				await postBackfillCompletionNotices(
					discord,
					repo,
					configs,
					runWorkSpaces,
				);
			} catch (err) {
				log.error("backfill completion notice failed", err);
			}
		} catch (err) {
			log.error("Phase-2 backfill failed", err);
		} finally {
			phase2Running = false;
		}
	})();
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

			// Capacity enforcement: skip room creation for spaces whose
			// bridged guild is over the space's member capacity.
			if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
				log.warn(
					`capacity: room creation skipped for ${spaceDid} (guild ${guildId}): guild over space member capacity`,
					{ guildId, spaceDid },
				);
				continue;
			}

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
			let skippedNameResolution = 0;

			for (const channelId of channelIds) {
				try {
					if (repo.getRoomyId(spaceDid, "channel", channelId)) continue;

					const channelName = await resolveChannelFieldWithRetry(() =>
						discord.resolveChannelName(channelId),
					);
					if (!channelName) {
						skippedNameResolution++;
						log.error(
							`Cannot resolve name for Discord channel ${channelId} in guild ${guildId} after ${RESOLUTION_RETRY_ATTEMPTS} attempts; skipping room creation`,
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

			if (created > 0 || skippedNameResolution > 0) {
				log.info(
					`Room creation for ${channelIds.length} bridged channels in ${spaceDid}: ${created} created, ${skippedNameResolution} skipped (name not resolvable after ${RESOLUTION_RETRY_ATTEMPTS} attempts)`,
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

export async function ensureRoomyThreads(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	configs: BridgeConfig[],
): Promise<void> {
	for (const config of configs) {
		try {
			const { guildId, spaceDid, mode } = config;

			// Capacity enforcement: skip thread creation for spaces whose
			// bridged guild is over the space's member capacity.
			if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
				log.warn(
					`capacity: thread creation skipped for ${spaceDid} (guild ${guildId}): guild over space member capacity`,
					{ guildId, spaceDid },
				);
				continue;
			}

			const guild = await discord.getGuild(guildId);
			if (!guild?.channels) continue;

			// Discover which parent channels are bridged.
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

			// Fetch active threads from the guild-level endpoint.
			const activeThreads = await discord.getActiveThreads(guildId);
			const threads = activeThreads.filter(
				(ch) => ch.parentId && bridgedChannelIds.has(ch.parentId),
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
							defaultAccess:
								thread.type === PRIVATE_THREAD ? "none" : undefined,
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

					// Backfill this active thread's recent window (Phase 1).
					// The Phase-2 walk (scheduled by runBackfill) covers the
					// remainder for threads truncated at the bound. Skip if
					// another backfill is already walking this thread.
					const threadKey = `${threadId}:${spaceDid}`;
					if (activeBackfills.has(threadKey)) continue;
					await backfillRecentWindow(
						discord,
						repo,
						roomy,
						threadId,
						spaceDid,
						guildId,
						"thread",
						parentId,
					);
				} catch (err) {
					log.error(
						`Failed to create Roomy thread for ${thread.id} in ${spaceDid}`,
						err,
					);
				}
			}

			if (created > 0) {
				markRunWork(spaceDid);
				log.info(
					`Created ${created} Roomy threads in ${spaceDid} and backfilled their messages`,
				);
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

/**
 * Enumerate the backfill work set up front: create a progress row
 * for every bridged (channel, space) pair and every bridged active-thread
 * pair so the Roomy backfill-status panel can list the entire set from the
 * start. Rows that already carry real progress (or a cursor) are left
 * untouched — enumeration never regresses phase or counts. Archived threads
 * are deliberately excluded: they are discovered lazily by Phase 2's
 * deprioritized sweep, per the two-phase design.
 *
 * Runs inside runBackfill, before the Phase-1 window; best-effort per
 * config (a failure here logs and lets the rest of the backfill proceed —
 * rows will simply appear as Phase 2 walks along).
 */
export async function enumerateBackfillWork(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	configs: BridgeConfig[],
): Promise<void> {
	for (const config of configs) {
		try {
			const { guildId, spaceDid, mode } = config;
			if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) continue;

			const guild = await discord.getGuild(guildId);
			if (!guild?.channels) continue;
			const nameById = new Map(
				guild.channels.map((ch) => [ch.id, ch.name ?? null]),
			);

			let channelIds: string[];
			if (mode === "full") {
				channelIds = guild.channels
					.filter((ch) => CHANNEL_TYPES.has(ch.type))
					.map((ch) => ch.id);
			} else {
				const allowlisted = new Set(
					repo.listAllowlistForBridge(spaceDid).map((e) => e.channelId),
				);
				channelIds = guild.channels
					.filter((ch) => CHANNEL_TYPES.has(ch.type) && allowlisted.has(ch.id))
					.map((ch) => ch.id);
			}

			for (const channelId of channelIds) {
				if (repo.getBackfillProgress(spaceDid, channelId)) continue;
				if (repo.getChannelCursor(spaceDid, channelId)) continue;
				repo.upsertBackfillProgress({
					spaceDid,
					channelId,
					guildId,
					kind: "channel",
					channelName: nameById.get(channelId) ?? null,
					phase: "phase1",
					messagesSynced: 0,
					messagesSkipped: 0,
					windowBoundary: null,
					walkCursor: null,
					parentId: null,
					windowSynced: null,
				});
			}

			// Active threads under bridged parents (mirrors ensureRoomyThreads).
			const bridgedParents = new Set(channelIds);
			const activeThreads = await discord.getActiveThreads(guildId);
			for (const thread of activeThreads) {
				if (!thread.parentId || !bridgedParents.has(thread.parentId)) {
					continue;
				}
				if (repo.getBackfillProgress(spaceDid, thread.id)) continue;
				if (repo.getChannelCursor(spaceDid, thread.id)) continue;
				repo.upsertBackfillProgress({
					spaceDid,
					channelId: thread.id,
					guildId,
					kind: "thread",
					channelName: thread.name ?? null,
					phase: "phase1",
					messagesSynced: 0,
					messagesSkipped: 0,
					windowBoundary: null,
					walkCursor: null,
					parentId: thread.parentId ?? null,
					windowSynced: null,
				});
			}
		} catch (err) {
			log.error(`enumerateBackfillWork failed for ${config.spaceDid}`, err);
		}
	}
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

/**
 * Phase 1: the bounded recent window for one (channel, space) pair.
 *
 * Pages the channel newest-first via `before`-pagination and ingests up to
 * PHASE1_MESSAGE_BOUND messages — the most recent ones — so the space is
 * immediately usable. Ends when the page returns fewer than
 * PHASE1_PAGE_SIZE messages (the whole history fit → pair is `complete` on
 * the spot) or when the bound is reached (→ `phase2` with `windowBoundary`
 * set to the oldest message ingested; the Phase-2 walk covers everything
 * strictly below it).
 *
 * Invariants:
 * - Falsifiable bound: this function ingests at most PHASE1_MESSAGE_BOUND
 *   messages per (channel, space).
 * - Advance-on-success-only / stall guard (mirrors the walk): `before` only
 *   moves after a successful page, and a page that fails to be strictly
 *   older than the previous `before` stops the window instead of looping.
 * - The caller holds this pair's guard in `activeBackfills` (or has verified
 *   no other backfill is running for it).
 *
 * `channel_cursors.last_message_id` is written monotonically (never
 * regressed): the live path updates it with each live message, and the walk
 * only ever pushes it up.
 */
export async function backfillRecentWindow(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	channelId: string,
	spaceDid: string,
	guildId: string,
	kind: "channel" | "thread" | null,
	parentId?: string | null,
): Promise<void> {
	const existing = repo.getBackfillProgress(spaceDid, channelId);
	const channelName =
		existing?.channelName ??
		// Display-only: a transiently unresolvable name costs one call, not
		// the retry backoff budget (the row simply carries null).
		((await discord.resolveChannelName(channelId)) ?? null);

	let synced = existing?.messagesSynced ?? 0;
	let skipped = existing?.messagesSkipped ?? 0;
	let before: string | undefined;
	let oldestIngested: string | null = null;
	let reachedStart = false;
	let stalled = false;

	const flush = (
		phase: "phase1" | "phase2" | "complete",
		windowSynced: number | null = null,
	) => {
		repo.upsertBackfillProgress({
			spaceDid,
			channelId,
			guildId,
			kind,
			channelName,
			phase,
			messagesSynced: synced,
			messagesSkipped: skipped,
			windowBoundary: oldestIngested,
			walkCursor: null,
			parentId: parentId ?? existing?.parentId ?? null,
			windowSynced: windowSynced ?? existing?.windowSynced ?? null,
		});
	};

	flush("phase1");

	for (;;) {
		const page = await discord.getMessages(channelId, {
			before,
			limit: PHASE1_PAGE_SIZE,
		});
		if (page.length === 0) {
			reachedStart = true;
			break;
		}
		const oldest = page.at(-1);
		if (!oldest) break;
		// Stall guard: pages must be strictly older than the previous
		// `before` — a sticky data source would otherwise loop forever.
		if (before !== undefined && BigInt(oldest.id) >= BigInt(before)) {
			stalled = true;
			log.error(
				`Phase-1 backfill stalled for ${channelId} → ${spaceDid}: page did not advance past ${before}; stopping`,
			);
			break;
		}

		for (const message of page) {
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
				synced += result.synced;
				skipped += result.skipped;
			} catch (err) {
				log.error(
					`Error processing message in Phase-1 backfill for channel ${channelId}`,
					err,
				);
			}
		}

		if (oldestIngested === null || BigInt(oldest.id) < BigInt(oldestIngested)) {
			oldestIngested = oldest.id;
		}
		flush("phase1");

		// Newest-ingested cursor: monotonic max (never regresses what the
		// live path wrote).
		const newestId = page[0]?.id;
		if (newestId !== undefined) {
			const prev = repo.getChannelCursor(spaceDid, channelId)?.lastMessageId;
			if (
				prev === null ||
				prev === undefined ||
				BigInt(newestId) > BigInt(prev)
			) {
				repo.setChannelCursor(spaceDid, channelId, newestId);
			}
		}

		if (page.length < PHASE1_PAGE_SIZE) {
			reachedStart = true;
			break;
		}
		if (synced + skipped >= PHASE1_MESSAGE_BOUND) break;
		before = oldest.id;
	}

	if (reachedStart) {
		if (existing?.phase !== "complete") markRunWork(spaceDid);
		flush("complete");
		log.info(
			`Channel ${channelId} → ${spaceDid} backfill complete in Phase 1: ${synced} synced, ${skipped} skipped`,
		);
		return;
	}

	if (stalled) {
		// Failed to advance — keep what we have, leave the pair in phase2 so
		// a later run can resume; a fixed data source will then catch up.
		flush("phase2");
		log.error(
			`Channel ${channelId} → ${spaceDid} Phase 1 stalled after ${synced + skipped} messages`,
		);
		return;
	}

	// Snapshot the window size for the status UI ("recent window done: N
	// messages, deep backfill queued").
	flush("phase2", synced);
	log.info(
		`Channel ${channelId} → ${spaceDid} Phase 1 reached bound (${PHASE1_MESSAGE_BOUND} messages); remaining history queued for Phase 2`,
	);
}

export async function backfillChannel(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	channelId: string,
	spaceDid: string,
	guildIdOverride?: string,
	parentId?: string | null,
): Promise<void> {
	const key = `${channelId}:${spaceDid}`;
	if (activeBackfills.has(key)) {
		log.debug(`Skipping backfill for ${key}: already in progress`);
		return;
	}
	activeBackfills.add(key);

	try {
		const guildId =
			guildIdOverride ??
			(await resolveChannelFieldWithRetry(() =>
				discord.resolveGuildIdForChannel(channelId),
			));
		if (!guildId) {
			log.error(
				`Cannot resolve guildId for channel ${channelId} after ${RESOLUTION_RETRY_ATTEMPTS} attempts; skipping backfill`,
			);
			// Surface as a failure so the run summary counts it instead of
			// reporting success while this channel's history is silently
			// missing. Callers (runBackfill, backfillSingleChannel) already
			// catch and log/report failures.
			throw new Error(`Cannot resolve guildId for channel ${channelId}`);
		}

		// Capacity enforcement: backfill is the main cost driver — abort
		// before it starts when the bridged guild is over the space's member
		// capacity. The owner DM fires via the capacity service's state-change
		// callback when the check flips to disabled.
		if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
			log.warn(
				`capacity: backfill aborted for channel ${channelId} → ${spaceDid} (guild ${guildId}): guild over space member capacity`,
				{ guildId, spaceDid, channelId },
			);
			return;
		}

		const cursor = repo.getChannelCursor(spaceDid, channelId);
		const progress = repo.getBackfillProgress(spaceDid, channelId);
		if (progress?.phase === "complete") {
			log.info(
				`Channel ${channelId} → ${spaceDid} already backfilled (complete)`,
			);
			return;
		}

		// Brand-new pair (no progress row and no cursor): run the bounded
		// recent window first (Phase 1), then walk the remainder below.
		// A fresh enumeration row (zero real work) counts as brand-new too —
		// its window has not run yet. Pairs with a cursor or real progress
		// are mid-walk or interrupted — Phase 2 resumes them without
		// re-running the window.
		if (!cursor && (!progress || !hasRealBackfillProgress(progress))) {
			const cachedChannel = await discord.getChannel(channelId);
			const kind = cachedChannel ? mappingKindForChannel(cachedChannel) : null;
			await backfillRecentWindow(
				discord,
				repo,
				roomy,
				channelId,
				spaceDid,
				guildId,
				kind,
				parentId ?? cachedChannel?.parentId ?? null,
			);
		}

		// The window covered the whole history (it ended on a short/empty
		// page) → the pair is complete; nothing left to walk.
		if (repo.getBackfillProgress(spaceDid, channelId)?.phase === "complete") {
			log.info(
				`Channel ${channelId} → ${spaceDid} fully backfilled by the Phase-1 window`,
			);
			return;
		}

		// ── Phase 2: walk the remainder (resumes across restarts) ─────────
		const progress2 = repo.getBackfillProgress(spaceDid, channelId);
		const boundary = progress2?.windowBoundary ?? null;

		let afterCursor: string;
		if (progress2?.walkCursor) {
			afterCursor = progress2.walkCursor;
		} else if (progress2) {
			// Interrupted window (phase1) or window done / walk not started
			// (phase2): start below everything — the boundary guard skips the
			// already-ingested top.
			afterCursor = channelId;
		} else {
			// No progress row: resume from the newest ingested message, or
			// from the channel start when there is none.
			afterCursor = cursor?.lastMessageId ?? channelId;
		}

		log.info(
			`Backfilling channel ${channelId} → ${spaceDid} (phase ${progress2?.phase ?? "legacy"}, from ${afterCursor})`,
		);

		const baseSynced = progress2?.messagesSynced ?? 0;
		const baseSkipped = progress2?.messagesSkipped ?? 0;
		let totalSynced = 0;
		let totalSkipped = 0;
		let walkStalled = false;

		// Progress-row identity; only resolved for pairs with no row yet
		// (the walk's "legacy" phase) — existing rows carry name/kind/guild.
		let identityKind = progress2?.kind ?? null;
		let identityName = progress2?.channelName ?? null;
		let identityParentId = parentId ?? progress2?.parentId ?? null;
		if (!progress2) {
			const cachedChannel = await discord.getChannel(channelId);
			if (cachedChannel) {
				identityKind = mappingKindForChannel(cachedChannel);
				identityParentId = parentId ?? cachedChannel.parentId ?? null;
			}
			identityName =
				(await resolveChannelFieldWithRetry(() =>
					discord.resolveChannelName(channelId),
				)) ?? null;
		}
		const identityGuildId = progress2?.guildId ?? guildId;

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
				// Everything at/above the Phase-1 boundary was already ingested
				// by the window — never re-process it.
				if (boundary !== null && BigInt(message.id) >= BigInt(boundary)) {
					totalSkipped++;
					continue;
				}
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
			const oldestInBatch = sortedMessages.at(-1);
			if (!oldestInBatch) break;
			const nextCursor = oldestInBatch.id;

			// Stall guard: a page whose oldest message hasn't advanced past
			// the cursor (sticky data source) would loop forever — stop and
			// keep the pair resumable instead.
			if (BigInt(nextCursor) <= BigInt(afterCursor)) {
				walkStalled = true;
				log.error(
					`Backfill stalled for ${channelId} → ${spaceDid}: cursor ${afterCursor} did not advance; stopping`,
				);
				break;
			}
			afterCursor = nextCursor;

			repo.upsertBackfillProgress({
				spaceDid,
				channelId,
				guildId: identityGuildId,
				kind: identityKind,
				channelName: identityName,
				phase: "phase2",
				messagesSynced: baseSynced + totalSynced,
				messagesSkipped: baseSkipped + totalSkipped,
				windowBoundary: boundary,
				walkCursor: afterCursor,
				parentId: identityParentId,
				windowSynced: progress2?.windowSynced ?? null,
			});

			// Newest-ingested cursor is a monotonic max: never regress what
			// the Phase-1 window / live path already wrote.
			const prevCursor = repo.getChannelCursor(spaceDid, channelId)
				?.lastMessageId;
			if (
				prevCursor === null ||
				prevCursor === undefined ||
				BigInt(afterCursor) > BigInt(prevCursor)
			) {
				repo.setChannelCursor(spaceDid, channelId, afterCursor);
			}

			if (messages.length < 100) break;
			// Phase-1 boundary reached from below: everything strictly below
			// it is ingested — the window covered the rest.
			const newestInBatch = messages[0];
			if (
				boundary !== null &&
				newestInBatch &&
				BigInt(newestInBatch.id) >= BigInt(boundary)
			) {
				break;
			}
		}

		if (!walkStalled) {
			if (progress2?.phase !== "complete") markRunWork(spaceDid);
			repo.upsertBackfillProgress({
				spaceDid,
				channelId,
				guildId: identityGuildId,
				kind: identityKind,
				channelName: identityName,
				phase: "complete",
				messagesSynced: baseSynced + totalSynced,
				messagesSkipped: baseSkipped + totalSkipped,
				windowBoundary: boundary,
				walkCursor: afterCursor,
				parentId: identityParentId,
				windowSynced: progress2?.windowSynced ?? null,
			});
		}

		log.info(
			`Channel ${channelId} → ${spaceDid} backfill done: ${baseSynced + totalSynced} synced, ${baseSkipped + totalSkipped} skipped${walkStalled ? " (stalled)" : ""}`,
		);

		// Capacity enforcement: refresh the decision after a backfill so a
		// member-count change during the run is picked up promptly (the
		// state-change callback logs/DMs on any flip).
		await getCapacityGate().isEnabled(guildId, spaceDid);
	} finally {
		activeBackfills.delete(key);
	}
}

/**
 * Fetch public archived threads for all bridged parent channels, create Roomy
 * rooms for any that aren't yet mapped, and backfill their messages.
 *
 * Exported for the tests covering pagination, page-failure isolation, and the
 * stall guard.
 */
export async function ensureAndBackfillArchivedThreads(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	configs: BridgeConfig[],
): Promise<void> {
	log.info("Starting archived thread backfill...");

	const CHANNEL_DELAY_MS = 1_000;
	const BACKFILL_DELAY_MS = 500;
	let totalThreads = 0;
	let failedParentChannels = 0;

	for (const config of configs) {
		try {
			const { guildId, spaceDid, mode } = config;

			// Capacity enforcement: skip archived-thread backfill for spaces
			// whose bridged guild is over the space's member capacity.
			if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
				log.warn(
					`capacity: archived thread backfill skipped for ${spaceDid} (guild ${guildId}): guild over space member capacity`,
					{ guildId, spaceDid },
				);
				continue;
			}

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
								thread.parentId ?? null,
							);

							await delay(BACKFILL_DELAY_MS);
						}

						// Advance the cursor only from a successful page, and stop
						// if a page fails to move it — otherwise a sticky page
						// would loop forever. A stalled page is counted as a
						// per-parent-channel failure.
						const lastThread = result.threads.at(-1);
						if (!lastThread) break;
						if (cursor !== undefined && lastThread.id === cursor) {
							failedParentChannels++;
							log.error(
								`Archived thread pagination stalled for parent channel ${parentChannelId} in ${spaceDid}: cursor ${cursor} did not advance; stopping`,
							);
							break;
						}
						cursor = lastThread.id;
						hasMore = result.hasMore ?? false;
					}

					parentChannelsProcessed++;

					if (parentChannelsProcessed < bridgedParentChannels.length) {
						await delay(CHANNEL_DELAY_MS);
					}
				} catch (err) {
					failedParentChannels++;
					log.error(
						`Failed to backfill archived threads for parent channel ${parentChannel.id} in ${spaceDid}`,
						err,
					);
				}
			}

			log.info(
				`Archived thread backfill for ${spaceDid}: processed ${totalThreads} threads across ${parentChannelsProcessed} parent channels, ${failedParentChannels} parent channel failures`,
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

/**
 * Post the Discord-side "backfill complete" system message for
 * every bridged space that the current run actually did work for.
 *
 * Completion point: the NOTICE fires only after ALL phases are done — every
 * bridged channel, every active thread, and the deprioritized archived-thread
 * sweep — so "complete" means the entire history of the server is synced, not
 * just the Phase-1 windows. Archived threads are included rather than
 * excluded, because the bridge treats them as part of the space's history and
 * the Roomy-side notice would otherwise under-report on servers with
 * archived threads.
 *
 * Destination channel (first match wins):
 *  1. BACKFILL_NOTICE_CHANNEL env override, if it names a reachable
 *     top-level channel;
 *  2. the guild's first announcement channel (type GUILD_ANNOUNCEMENT) — the
 *     conventional place for server-wide status messages;
 *  3. the first bridged top-level text channel of the guild.
 *
 * Best-effort by design: a missing guild, unreachable channel, or failed
 * send is logged and skips — it never throws, and never fails the backfill
 * run itself.
 */
export async function postBackfillCompletionNotices(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	configs: BridgeConfig[],
	workSpaces: ReadonlySet<string>,
): Promise<void> {
	if (!noticeSender) {
		log.debug("backfill completion notice: no sender installed; skipping");
		return;
	}
	for (const config of configs) {
		if (!workSpaces.has(config.spaceDid)) continue;
		try {
			const channelId = await resolveBackfillNoticeChannel(
				discord,
				repo,
				config,
			);
			if (!channelId) {
				log.warn(
					`backfill completion notice: no reachable top-level channel in guild ${config.guildId} for ${config.spaceDid}; skipping`,
				);
				continue;
			}
			const summary = backfillSummary(repo, config);
			const pending = summary.pending > 0 ? ` ${summary.pending} item(s) still pending` : "";
			const plural = (n: number, word: string) =>
				`${n} ${word}${n === 1 ? "" : "s"}`;
			const text =
				`Roomy backfill complete: this server's history is synced to Roomy ` +
				`(${plural(summary.channels, "channel")}, ${plural(summary.threads, "thread")}).` +
				pending;
			await noticeSender.sendMessage(channelId, text);
			log.info(
				`backfill completion notice posted to ${channelId} for ${config.spaceDid}`,
			);
		} catch (err) {
			log.error(
				`backfill completion notice failed for ${config.spaceDid}`,
				err,
			);
		}
	}
}

/** Pick the destination channel for the completion notice (see postBackfillCompletionNotices). */
async function resolveBackfillNoticeChannel(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	config: BridgeConfig,
): Promise<string | undefined> {
	const override = BACKFILL_NOTICE_CHANNEL();
	if (override) {
		const channel = await discord.getChannel(override);
		if (channel && CHANNEL_TYPES.has(channel.type)) return override;
		log.warn(
			`BACKFILL_NOTICE_CHANNEL ${override} is not a reachable top-level channel; falling back to a guild channel`,
		);
	}

	const guild = await discord.getGuild(config.guildId);
	const channels = guild?.channels ?? [];

	const announcement = channels.find((ch) => ch.type === 5);
	if (announcement) return announcement.id;

	const preferred =
		config.mode === "full"
			? channels
			: (() => {
					const allowlisted = new Set(
						repo.listAllowlistForBridge(config.spaceDid).map(
							(e) => e.channelId,
						),
					);
					return channels.filter(
						(ch) => CHANNEL_TYPES.has(ch.type) && allowlisted.has(ch.id),
					);
				})();
	const first = preferred.find((ch) => CHANNEL_TYPES.has(ch.type)) ??
		channels.find((ch) => CHANNEL_TYPES.has(ch.type));
	return first?.id;
}

/** Tally the per-space progress rows into a message summary. */
function backfillSummary(
	repo: BridgeRepository,
	config: BridgeConfig,
): { channels: number; threads: number; pending: number } {
	let channels = 0;
	let threads = 0;
	let pending = 0;
	for (const p of repo.listBackfillProgress(config.spaceDid)) {
		if (p.guildId !== null && p.guildId !== config.guildId) continue;
		if (p.phase === "complete") {
			if (p.kind === "thread") threads++;
			else channels++;
		} else {
			pending++;
		}
	}
	return { channels, threads, pending };
}
