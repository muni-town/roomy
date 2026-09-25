import { type Event, newUlid, Ulid } from "@roomy-space/sdk";
import type { BridgeConfig, BridgeRepository } from "../db/repository.ts";
import type { DiscordChannelData } from "../discord/data.ts";
import {
	CATEGORY_TYPE,
	CHANNEL_TYPES,
	isChannelPublic,
	mappingKindForChannel,
	PRIVATE_THREAD,
	THREAD_TYPES,
} from "../discord/data.ts";
import type { DiscordDataSource } from "../discord/data-source.ts";
import { createLogger } from "../logger.ts";
import { getCapacityGate } from "../roomy/capacity.ts";
import type { BridgeSidebarCategory, RoomyGateway } from "../roomy/gateway.ts";

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

// ─── Initial structure sync (one-shot) ──────────────────────────────────
//
// Discord's guild structure — which category each channel sits in, and the
// order of both — is mirrored into the Roomy sidebar ONCE, when a guild is
// first bridged. It is never re-synced: Discord stays the source of truth for
// message content, but the Roomy sidebar belongs to the space's admins after
// the initial import, so a later Discord channel rename, move, or reorder
// must not stomp their layout.
//
// The one-shot property is enforced by a persisted marker in the bridge's own
// DB (`structure_sync`, repository.ts), NOT by a check against the live
// sidebar: a sidebar check would re-apply structure whenever the merge
// happened to produce a different result, and a marker survives the space
// being modified by an admin afterwards, which a check cannot distinguish
// from "not yet synced". The marker is claimed before any event is sent, so a
// crash mid-sync leaves it set and the structure is never applied twice; a
// failed first attempt can be retried once by the recovery path (see below)
// and is otherwise reported as the honest outcome (`applied: false`).

/**
 * Discord's guild structure, as read for the initial sync: the categories in
 * display order, and the channels in each — itself in display order, which is
 * what `position` exists to express.
 *
 * A category with no name is dropped at read time rather than carried with a
 * placeholder: the merge matches Discord categories to Roomy ones by name (the
 * only handle the two systems share), so a nameless one could never be matched
 * and would appear as a header named after its snowflake. `position` is
 * optional because Discord omits it for some payload shapes; absent sorts
 * first, matching how Discord displays it.
 */
export interface DiscordGuildStructure {
	categories: Array<{
		id: string;
		name: string;
		position?: number;
	}>;
	/** Every non-thread channel in the guild, with its category + position. */
	channels: DiscordChannelData[];
}

/**
 * Read a guild's categories and channel order from a data source.
 *
 * Threads are excluded: they belong to a parent channel rather than to the
 * category, and Discord reports their `parent_id` as the *channel*, not the
 * category — reading `parentId` without checking the type is the documented
 * mistake here (see discord/live-sender.ts:233: a guild text channel also
 * carries a `parentId`, its category).
 */
export async function readGuildStructure(
	discord: DiscordDataSource,
	guildId: string,
): Promise<DiscordGuildStructure> {
	const guild = await discord.getGuild(guildId);
	const channels = guild?.channels ?? [];

	const categories: DiscordGuildStructure["categories"] = [];
	for (const ch of channels) {
		if (ch.type !== CATEGORY_TYPE) continue;
		if (ch.name === undefined) continue;
		categories.push({
			id: ch.id,
			name: ch.name,
			...(ch.position !== undefined ? { position: ch.position } : {}),
		});
	}
	categories.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

	return {
		categories,
		channels: channels.filter((ch) => !THREAD_TYPES.has(ch.type)),
	};
}

/**
 * Merge Discord's structure into a space's existing sidebar.
 *
 * Existing categories are preserved (they may hold Roomy-native or federated
 * rooms the bridge did not create), and a Discord category is matched to an
 * existing one by name — the only stable handle across the two systems, since
 * Roomy category ids are assigned by whoever wrote the sidebar. Matching is
 * case-insensitive: Roomy seeds `general` lower-case while Discord servers
 * report the name as typed, and a verbatim comparison would forge a second
 * header beside the seeded one. Channels are grouped by their Discord
 * category, ordered by `position`, and appended to their category's children;
 * channels in no category go to the end of the first category, matching where
 * the client puts orphans in its edit view. A room already present in any
 * category is never appended under a second one.
 *
 * Returns categories in render order. Pure, so the merge is testable without
 * a space.
 */
export function mergeGuildStructure(
	existing: BridgeSidebarCategory[],
	structure: DiscordGuildStructure,
	roomIdByChannelId: Map<string, string>,
): BridgeSidebarCategory[] {
	const merged = existing.map((cat) => ({
		...cat,
		children: [...cat.children],
	}));
	// Match by normalised (lower-cased) name. The name is the only stable
	// handle the two systems share, but its case is not: Roomy seeds a
	// lower-case `general` (`sdk/src/operations/space.ts`) while Discord
	// guilds report whatever casing the admin typed, so a verbatim match
	// creates a second, differently-cased header beside the seeded one.
	// First-wins: if the sidebar holds both casings, the first — the seeded,
	// canonical one — gets the rooms.
	const byName = new Map<string, BridgeSidebarCategory>();
	for (const cat of merged) {
		const key = cat.name.toLowerCase();
		if (!byName.has(key)) byName.set(key, cat);
	}

	// Global room guard: a room already present in ANY category — moved there
	// by an admin, or by a previous merge — is never appended a second time
	// under a different header. Per-category checks miss exactly that.
	const placedRooms = new Set(merged.flatMap((cat) => cat.children));

	// Group bridged channels under their Discord category, in position order.
	// A channel with no mapping was not created (subset bridge, failed
	// create, private) and is left out rather than pointing at a missing room.
	const ordered = [...structure.channels].sort(
		(a, b) => (a.position ?? 0) - (b.position ?? 0),
	);
	const uncategorized = new Set<string>();
	const groups = new Map<string, string[]>();

	for (const channel of ordered) {
		const roomId = roomIdByChannelId.get(channel.id);
		if (!roomId) continue;
		const categoryId = channel.parentId;
		if (categoryId === undefined) {
			uncategorized.add(roomId);
			continue;
		}
		const group = groups.get(categoryId) ?? [];
		group.push(roomId);
		groups.set(categoryId, group);
	}

	const placed = new Set<string>();
	for (const category of structure.categories) {
		const children = groups.get(category.id);
		if (!children || children.length === 0) {
			// A category the guild reports whose channels are all unbridged is
			// skipped: an empty category is a header with nothing under it.
			continue;
		}
		placed.add(category.id);

		// Drop rooms already placed under any header; the rest keep their
		// Discord position order. An all-duplicate category creates no header
		// with nothing new under it.
		const fresh = children.filter((roomId) => !placedRooms.has(roomId));
		if (fresh.length === 0) continue;

		const target = byName.get(category.name.toLowerCase());
		if (target) {
			target.children.push(...fresh);
		} else {
			const created: BridgeSidebarCategory = {
				name: category.name,
				children: fresh,
			};
			merged.push(created);
			byName.set(category.name.toLowerCase(), created);
		}
		for (const roomId of fresh) placedRooms.add(roomId);
	}

	// A bridged channel whose category is absent from the guild payload (the
	// category was deleted, or the response was partial) has no header to hang
	// under. Fall back to the uncategorized path rather than dropping the room
	// from the sidebar entirely.
	for (const [categoryId, children] of groups) {
		if (placed.has(categoryId)) continue;
		for (const roomId of children) uncategorized.add(roomId);
	}

	// Uncategorized channels land in the first category. That is where the
	// client renders orphans in its edit view, so the sidebar a bridged guild
	// produces looks the same as the one its admin would see while editing.
	if (uncategorized.size > 0) {
		const fallback: BridgeSidebarCategory = { name: "general", children: [] };
		const first = merged[0] ?? fallback;
		if (merged.length === 0) merged.push(first);
		for (const roomId of uncategorized) {
			if (!placedRooms.has(roomId)) {
				first.children.push(roomId);
				placedRooms.add(roomId);
			}
		}
	}

	return merged;
}

/**
 * Apply Discord's category structure and channel order to a space — ONCE.
 *
 * Called from `runBackfill` (the initial-sync path: gateway READY, and the
 * connect/backfill slash commands), never from a live gateway event handler.
 * `handleChannelCreate` and friends deliberately do not call this: they fire
 * on ongoing Discord events, and a structure write there would be exactly the
 * ongoing re-sync this one-shot mirror prevents.
 *
 * The marker is per (guild, space). `repo.claimStructureSync` returns false
 * once claimed, so a second call — a reconnect, a second backfill, a
 * re-run of the slash command — is a no-op that sends no events. That is the
 * whole guarantee: the only writer of this structure is the first call, and
 * it is recorded in the bridge's DB rather than inferred from the space.
 */
export async function syncInitialStructure(
	discord: DiscordDataSource,
	repo: BridgeRepository,
	roomy: RoomyGateway,
	configs: BridgeConfig[],
): Promise<void> {
	for (const config of configs) {
		const { guildId, spaceDid, mode } = config;
		try {
			if (!(await getCapacityGate().isEnabled(guildId, spaceDid))) {
				log.warn(
					`capacity: initial structure sync skipped for ${spaceDid} (guild ${guildId})`,
					{ guildId, spaceDid },
				);
				continue;
			}

			// Claim BEFORE reading or writing anything. Claiming first makes
			// the sync at-most-once by construction: a crash after this line
			// leaves the marker set, so the structure is never applied twice.
			const claimed = repo.claimStructureSync(guildId, spaceDid);
			if (!claimed) {
				log.debug(
					`Initial structure already synced for ${spaceDid} (guild ${guildId})`,
				);
				continue;
			}

			const structure = await readGuildStructure(discord, guildId);

			// Rooms this bridge created. Read after room creation (runBackfill
			// calls us last) so every bridged channel has its mapping.
			const roomIdByChannelId = new Map<string, string>();
			for (const channel of structure.channels) {
				if (!CHANNEL_TYPES.has(channel.type)) continue;
				if (mode === "subset" && !repo.isAllowlisted(spaceDid, channel.id)) {
					continue;
				}
				const roomId = repo.getRoomyId(spaceDid, "channel", channel.id);
				if (roomId) roomIdByChannelId.set(channel.id, roomId);
			}

			if (roomIdByChannelId.size === 0) {
				// Nothing to place, so nothing was written — release the claim
				// rather than burning it. A later backfill (rooms created on a
				// subsequent run) then still gets one initial sync. Re-sending
				// no events is not a re-sync; the guard exists to stop a second
				// WRITE, and this path performs none.
				repo.releaseStructureSync(guildId, spaceDid);
				log.info(
					`Initial structure sync for ${spaceDid}: no bridged channels, nothing to write`,
					{ guildId, spaceDid },
				);
				continue;
			}

			const existing = await roomy.getSidebar(spaceDid);
			// Never empty here: a channel was placed, so the merge produced at
			// least one category to hold it (or the uncategorized path created
			// one). Writing an empty sidebar would render a blank channel list.
			const categories = mergeGuildStructure(
				existing.categories,
				structure,
				roomIdByChannelId,
			);

			const event: Event = {
				id: newUlid(),
				$type: "space.roomy.space.updateSidebar.v1",
				categories: categories.map((cat) => ({
					id: cat.id !== undefined ? Ulid.assert(cat.id) : newUlid(),
					name: cat.name,
					children: cat.children.map((child) => Ulid.assert(child)),
				})),
			};

			await roomy.sendEvent(spaceDid, event);
			repo.markStructureSyncApplied(guildId, spaceDid);
			log.info(
				`Initial structure synced ${categories.length} categories / ${roomIdByChannelId.size} channels for ${spaceDid} (guild ${guildId})`,
			);
		} catch (err) {
			// The claim stays set on failure. That is deliberate: once an
			// event may have reached the space we cannot prove it did not, so
			// retrying would risk a second structure write. `applied_at` stays
			// null, which is how an operator tells "sync never completed" from
			// "sync done".
			log.error(
				`Failed to sync initial structure for ${spaceDid} (guild ${guildId})`,
				err,
			);
		}
	}
}
