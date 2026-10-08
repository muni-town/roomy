import { describe, expect, test } from "bun:test";
import { BridgeRepository } from "../db/repository.ts";
import type { DiscordChannelData } from "../discord/data.ts";
import { FileDiscordDataSource } from "../discord/file-data-source.ts";
import { enumerateBackfillWork } from "../services/backfill.ts";
import {
	START_LIVE_CURSOR,
	type ExistingThread,
	seedE2eFixtures,
} from "./seed-e2e-db.ts";

const GUILD = "987654321098765432";
const SPACE = "did:plc:e2efixture";
const CHANNEL = "200000000000000001";
const ROOM = "01KZNSNH2FM879C12C1VK87MY7";
const THREAD = "300000000000000001";

function seeded(existingThreads: ExistingThread[] = []): BridgeRepository {
	const repo = BridgeRepository.open(":memory:");
	seedE2eFixtures(repo, {
		guildId: GUILD,
		spaceDid: SPACE,
		roomUlid: ROOM,
		channelId: CHANNEL,
		existingThreads,
	});
	return repo;
}

describe("seedE2eFixtures", () => {
	test("writes the channel/space pair as an established connection", () => {
		const repo = seeded();

		expect(repo.getBridgeConfig(GUILD, SPACE)?.mode).toBe("subset");
		expect(repo.getTargetSpacesForChannel(GUILD, CHANNEL)).toEqual([SPACE]);
		expect(repo.isAllowlisted(SPACE, CHANNEL)).toBe(true);
		expect(repo.getRoomyId(SPACE, "channel", CHANNEL)).toBe(ROOM);
		expect(repo.getRoomyRoomId(SPACE, CHANNEL)).toBe(ROOM);

		const progress = repo.getBackfillProgress(SPACE, CHANNEL);
		expect(progress?.phase).toBe("complete");
		expect(progress?.kind).toBe("channel");
		expect(progress?.guildId).toBe(GUILD);

		expect(repo.hasClaimedStructureSync(GUILD, SPACE)).toBe(true);
		const applied = repo.__only_use_in_tests__db
			.query<{ applied_at: number | null }, [string, string]>(
				"SELECT applied_at FROM structure_sync WHERE guild_id = ? AND space_did = ?",
			)
			.get(GUILD, SPACE)?.applied_at;
		expect(applied).not.toBeNull();

		repo.close();
	});

	test("starts the Roomy side beyond every real event index", () => {
		const repo = seeded();

		const cursor = repo.getSpaceCursor(SPACE);
		expect(cursor).toBe(START_LIVE_CURSOR);
		// Whatever the space's log length, the cursor is past it: the appserver
		// backfills nothing and the bridge only sees live events.
		expect(START_LIVE_CURSOR).toBeGreaterThan(2 ** 40);

		repo.close();
	});

	test("leaves the pair out of the backfill work set", async () => {
		const repo = seeded();
		const config = repo.getBridgeConfig(GUILD, SPACE);
		if (!config)
			throw new Error("the seeded database carries no bridge config");
		const channel: DiscordChannelData = {
			id: CHANNEL,
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [channel] },
			channels: [channel],
		});

		await enumerateBackfillWork(discord, repo, [config]);

		const rows = repo.listBackfillProgress(SPACE);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.phase).toBe("complete");

		repo.close();
	});

	test("records the channel's existing threads as handled", () => {
		const repo = seeded([{ id: THREAD, name: "test thread" }]);

		// A placeholder room id: the sweeps skip a thread that has a mapping,
		// and the run posts into no thread it did not create, so nothing
		// resolves it.
		const placeholder = repo.getRoomyId(SPACE, "thread", THREAD);
		expect(placeholder).toBeTruthy();
		expect(placeholder).not.toBe(ROOM);

		const progress = repo.getBackfillProgress(SPACE, THREAD);
		expect(progress?.kind).toBe("thread");
		expect(progress?.phase).toBe("complete");
		expect(progress?.channelName).toBe("test thread");
		expect(progress?.parentId).toBe(CHANNEL);
		expect(repo.isAllowlisted(SPACE, THREAD)).toBe(false);

		repo.close();
	});

	test("an existing thread stays out of the backfill work set", async () => {
		const repo = seeded([{ id: THREAD }]);
		const config = repo.getBridgeConfig(GUILD, SPACE);
		if (!config)
			throw new Error("the seeded database carries no bridge config");
		const channel: DiscordChannelData = {
			id: CHANNEL,
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const thread: DiscordChannelData = {
			id: THREAD,
			type: 11,
			name: "test thread",
			parentId: CHANNEL,
			guildId: GUILD,
		};
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [channel] },
			channels: [channel, thread],
			activeThreads: [thread],
		});

		await enumerateBackfillWork(discord, repo, [config]);

		// Enumeration queues an active thread with no row of its own; the
		// seeded completed row is what stops it being queued.
		const rows = repo.listBackfillProgress(SPACE);
		expect(rows.map((row) => row.channelId).sort()).toEqual(
			[CHANNEL, THREAD].sort(),
		);
		expect(rows.every((row) => row.phase === "complete")).toBe(true);

		repo.close();
	});

	test("refuses a database that already belongs to a running bridge", () => {
		const repo = seeded();

		expect(() =>
			seedE2eFixtures(repo, {
				guildId: GUILD,
				spaceDid: SPACE,
				roomUlid: ROOM,
				channelId: CHANNEL,
				existingThreads: [],
			}),
		).toThrow(/already claimed/);

		repo.close();
	});
});
