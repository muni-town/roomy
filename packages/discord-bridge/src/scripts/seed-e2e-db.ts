/**
 * Seed a bridge database with the fixture rows a live E2E run needs.
 *
 * `src/scripts/e2e.ts` drives a *running* bridge and reads that bridge's own
 * SQLite DB to resolve the ids it asserts on (a Roomy message's Discord id, a
 * Discord message's Roomy id). The bridge whose DB is read has to be the
 * bridge doing the bridging, so a CI job that runs the E2E boots the bridge
 * from its own checkout — on an empty DB. An empty DB is a first-ever
 * connect, which is the opposite of what the E2E wants: the bridge would
 * re-ingest the bridged channel's Discord history into the space, rewrite the
 * space's sidebar from the guild structure, and replay the space's whole
 * event log — re-posting every bridged Roomy message it finds back to Discord.
 *
 * This script writes the rows that make the pair look like an established
 * connection instead:
 *
 *   - `bridge_config` + `allowlist` — the (guild, space) bridge in `subset`
 *     mode, covering exactly the E2E channel. Subset keeps every other channel
 *     in the guild out of the run.
 *   - `id_mappings` channel → Roomy room — the route the Roomy→Discord router
 *     needs to send that room's messages to Discord. The room already exists
 *     in the space, so seeding the mapping reuses it rather than creating a
 *     second one.
 *   - `backfill_progress` at phase `complete` — the Discord→Roomy history for
 *     that pair is already ingested, so booting does not walk it again.
 *   - `structure_sync` claimed and applied — the one-shot guild structure sync
 *     (categories and channel order) has already run, so booting does not
 *     write to the space's sidebar.
 *   - `space_cursors` at START_LIVE_CURSOR — the Roomy side starts live, not
 *     from the beginning of the space's log.
 *   - the threads already in the channel, recorded as handled (`id_mappings`
 *     + `backfill_progress` at phase `complete`) — on a fresh DB the bridge
 *     adopts every thread under a bridged channel it has no mapping for: it
 *     rooms the thread and ingests its history, once per dispatch.
 *
 * The DB must be fresh. A database that already carries a bridge config
 * belongs to a running bridge, and claiming its structure sync or completing
 * its backfill would change what it does on its next start.
 *
 * Inputs are the E2E script's own, minus the guild: `E2E_SPACE_DID`,
 * `E2E_ROOM_ULID`, `E2E_DISCORD_CHANNEL_ID`, and `BRIDGE_DB_PATH` for the
 * database to write. The guild id, and the threads already under the channel,
 * are read from Discord, so the fixture cannot name a guild the channel is not
 * in and cannot leave a thread of that channel unrecorded.
 *
 * Usage (from packages/discord-bridge, with .env loaded):
 *   export E2E_SPACE_DID=did:plc:...
 *   export E2E_ROOM_ULID=01...
 *   export E2E_DISCORD_CHANNEL_ID=147...
 *   BRIDGE_DB_PATH=/tmp/e2e-bridge.sqlite bun run src/scripts/seed-e2e-db.ts
 *
 * The bridge then starts with the same BRIDGE_DB_PATH, and the E2E runs
 * against it with the same three E2E_* values.
 */

import { newUlid } from "@roomy-space/sdk";
import { BRIDGE_DB_PATH, DISCORD_TOKEN } from "../env.ts";
import { BridgeRepository } from "../db/repository.ts";

const DISCORD_EPOCH_MS = 1420070400000; // 2015-01-01T00:00:00Z
const DISCORD_API = "https://discord.com/api/v10";

/**
 * Cursor the Roomy→Discord router starts from: an event index beyond any real
 * one, so the appserver backfills nothing and the bridge sees only live
 * events. The E2E asserts on events it creates after the bridge is up;
 * replaying history would re-post old messages to Discord instead.
 */
export const START_LIVE_CURSOR = Number.MAX_SAFE_INTEGER;

export type ExistingThread = {
	id: string;
	name?: string;
};

export type E2eFixture = {
	/** Guild the E2E channel belongs to. */
	guildId: string;
	/** Space the bridge bridges the channel into. */
	spaceDid: string;
	/** Roomy room of the bridged channel, as the E2E names it. */
	roomUlid: string;
	/** Discord channel the run bridges. */
	channelId: string;
	/** Threads already under `channelId`, active and archived. */
	existingThreads: ExistingThread[];
};

/**
 * Write the fixture rows for one (channel, space) bridge. Callers supply the
 * guild id and the channel's threads as resolved from Discord; nothing here
 * talks to Discord or to the appserver.
 */
export function seedE2eFixtures(
	repo: BridgeRepository,
	fixture: E2eFixture,
): void {
	const { guildId, spaceDid, roomUlid, channelId, existingThreads } = fixture;

	repo.upsertBridgeConfig(guildId, spaceDid, "subset");
	repo.addToAllowlist(spaceDid, channelId, guildId);
	repo.registerMapping(spaceDid, "channel", channelId, roomUlid);

	repo.upsertBackfillProgress({
		spaceDid,
		channelId,
		guildId,
		kind: "channel",
		phase: "complete",
		messagesSynced: 0,
		messagesSkipped: 0,
	});

	// The mapping keeps `ensureRoomyThreads` and the archived-thread sweep off
	// a thread; the completed progress row keeps `enumerateBackfillWork` from
	// queueing it and the history walk from taking it on. The mapped room id is
	// a placeholder: the run posts nothing into a thread it did not create, so
	// nothing resolves it.
	for (const thread of existingThreads) {
		repo.registerMapping(spaceDid, "thread", thread.id, newUlid());
		repo.upsertBackfillProgress({
			spaceDid,
			channelId: thread.id,
			guildId,
			kind: "thread",
			channelName: thread.name ?? null,
			phase: "complete",
			messagesSynced: 0,
			messagesSkipped: 0,
			parentId: channelId,
		});
	}

	if (!repo.claimStructureSync(guildId, spaceDid)) {
		throw new Error(
			`Structure sync for guild ${guildId} / space ${spaceDid} was already claimed; refusing to seed a DB that belongs to a running bridge.`,
		);
	}
	repo.markStructureSyncApplied(guildId, spaceDid);

	repo.setSpaceCursor(spaceDid, START_LIVE_CURSOR);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} environment variable not provided.`);
	return value;
}

async function discordGet(path: string): Promise<unknown> {
	const res = await fetch(`${DISCORD_API}${path}`, {
		headers: { Authorization: `Bot ${DISCORD_TOKEN()}` },
	});
	if (!res.ok) {
		throw new Error(`Discord GET ${path}: ${res.status} ${await res.text()}`);
	}
	return await res.json();
}

type DiscordThread = ExistingThread & { parentId?: string };

/**
 * Discord's thread lists are JSON with no schema here, so this keeps only the
 * entries whose id is a string: a malformed response must not reach the
 * fixture rows.
 */
function readThreadPage(page: unknown): {
	threads: DiscordThread[];
	hasMore: boolean;
} {
	const threads: DiscordThread[] = [];
	if (typeof page !== "object" || page === null) {
		return { threads, hasMore: false };
	}

	const entries: unknown = "threads" in page ? page.threads : undefined;
	const list: unknown[] = Array.isArray(entries) ? entries : [];
	for (const entry of list) {
		if (typeof entry !== "object" || entry === null) continue;
		const id = "id" in entry ? entry.id : undefined;
		if (typeof id !== "string") continue;
		const name = "name" in entry ? entry.name : undefined;
		const parentId = "parent_id" in entry ? entry.parent_id : undefined;
		threads.push({
			id,
			...(typeof name === "string" && { name }),
			...(typeof parentId === "string" && { parentId }),
		});
	}

	return { threads, hasMore: "has_more" in page && page.has_more === true };
}

/** Guild id of a channel, straight from Discord. */
async function resolveGuildId(channelId: string): Promise<string> {
	const channel = await discordGet(`/channels/${channelId}`);
	if (typeof channel !== "object" || channel === null) {
		throw new Error(`Discord channel ${channelId}: unexpected response.`);
	}
	const guildId = "guild_id" in channel ? channel.guild_id : undefined;
	if (typeof guildId !== "string" || !guildId) {
		throw new Error(`Discord channel ${channelId} is not a guild channel.`);
	}
	return guildId;
}

/**
 * Threads under a channel: the guild's active ones whose parent it is, plus
 * its archived public ones — the two sets `ensureRoomyThreads` and
 * `ensureAndBackfillArchivedThreads` walk.
 */
async function listExistingThreads(
	guildId: string,
	channelId: string,
): Promise<ExistingThread[]> {
	const threads = new Map<string, ExistingThread>();

	const active = readThreadPage(
		await discordGet(`/guilds/${guildId}/threads/active`),
	);
	for (const thread of active.threads) {
		if (thread.parentId !== channelId) continue;
		threads.set(thread.id, {
			id: thread.id,
			...(thread.name && { name: thread.name }),
		});
	}

	let before: string | undefined;
	for (;;) {
		const query = new URLSearchParams({ limit: "100" });
		if (before) query.set("before", before);
		const page = readThreadPage(
			await discordGet(
				`/channels/${channelId}/threads/archived/public?${query}`,
			),
		);
		for (const thread of page.threads) {
			threads.set(thread.id, {
				id: thread.id,
				...(thread.name && { name: thread.name }),
			});
		}

		// This endpoint pages by an ISO8601 `before`, so the cursor is the last
		// thread's snowflake timestamp — the same field
		// `snowflakeToEpochMs`(discord/live-data-source.ts) encodes for the
		// `before` discordeno passes. `has_more` is only honoured alongside a
		// cursor that advances; a page that does not move it would repeat
		// forever.
		const last = page.threads.at(-1);
		const next = last
			? new Date(
					Number(BigInt(last.id) >> 22n) + DISCORD_EPOCH_MS,
				).toISOString()
			: undefined;
		if (!page.hasMore || !next || next === before) break;
		before = next;
	}

	return [...threads.values()];
}

async function main(): Promise<void> {
	const spaceDid = required("E2E_SPACE_DID");
	const roomUlid = required("E2E_ROOM_ULID");
	const channelId = required("E2E_DISCORD_CHANNEL_ID");
	const dbPath = BRIDGE_DB_PATH();

	const guildId = await resolveGuildId(channelId);
	const existingThreads = await listExistingThreads(guildId, channelId);

	const repo = BridgeRepository.open(dbPath);
	try {
		const existing = repo.listAllBridgeConfigs();
		if (existing.length > 0) {
			throw new Error(
				`${dbPath} already carries ${existing.length} bridge config(s); it belongs to a running bridge. Seed a fresh path instead.`,
			);
		}

		seedE2eFixtures(repo, {
			guildId,
			spaceDid,
			roomUlid,
			channelId,
			existingThreads,
		});

		console.log(`[e2e-fixtures] guild ${guildId} → space ${spaceDid} (subset)`);
		console.log(`[e2e-fixtures] channel ${channelId} → room ${roomUlid}`);
		console.log(
			`[e2e-fixtures] ${existingThreads.length} existing thread(s) recorded as handled`,
		);
		console.log(
			`[e2e-fixtures] backfill complete, structure sync applied, Roomy cursor ${START_LIVE_CURSOR}`,
		);
		console.log(`[e2e-fixtures] wrote fixtures to ${dbPath}`);
	} finally {
		repo.close();
	}
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("e2e fixtures error:", err);
		process.exit(1);
	});
}
