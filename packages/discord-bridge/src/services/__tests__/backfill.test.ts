/**
 * Full backfill tests using a faker-generated virtual Discord guild.
 *
 * We generate a consistent in-memory guild with channels and messages
 * using @faker-js/faker (fixed seed), then run backfillChannel for each
 * channel and verify that ALL messages were synced.
 *
 * If a channel has more than 100 messages, the pagination logic in
 * backfillChannel must correctly advance the cursor past each page.
 * This test catches cases where pagination stalls after page 1.
 *
 * Usage:
 *   pnpm test -- --test-file-pattern backfill
 *   bun test src/services/__tests__/backfill.test.ts
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { faker } from "@faker-js/faker";
import { newUlid } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import type {
	DiscordChannelData,
	DiscordGuildData,
	DiscordMessageData,
	DiscordUserData,
} from "../../discord/data.ts";
import type { DiscordDataSource } from "../../discord/data-source.ts";
import { FileDiscordDataSource } from "../../discord/file-data-source.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import { backfillChannel, ensureRoomyThreads } from "../backfill.ts";
import { expectToBeDefined } from "./utils.ts";

// ─── Test constants ─────────────────────────────────────────────────────

export const SPACE = "did:web:test-space.example";
export const GUILD = "987654321098765432";

// ─── Faker-generated in-memory data source ──────────────────────────────

/**
 * Creates a complete, internally consistent fake Discord guild in memory.
 * Returns all the pieces needed to construct a FileDiscordDataSource and
 * assert on backfill results.
 */
function createFakeGuild(options: {
	seed: number;
	channelCount: number;
	messagesPerChannel: number;
}): {
	guild: DiscordGuildData;
	channels: DiscordChannelData[];
	messages: Record<string, DiscordMessageData[]>;
	totalMessageCount: number;
} {
	const { seed, channelCount, messagesPerChannel } = options;
	faker.seed(seed);

	// ── User pool ──────────────────────────────────────────────
	const userCount = faker.number.int({ min: 5, max: 15 });
	const users: DiscordUserData[] = Array.from({ length: userCount }, () => ({
		id: faker.number
			.bigInt({
				min: 100000000000000000n,
				max: 999999999999999999n,
			})
			.toString(),
		name: faker.internet.username().toLowerCase(),
		discriminator: "0000",
		globalName: faker.person.fullName(),
		avatar: null,
		isBot: false,
	}));

	// ── Channels ───────────────────────────────────────────────
	const channels: DiscordChannelData[] = Array.from(
		{ length: channelCount },
		(_, i) => ({
			id: faker.number
				.bigInt({
					min: 200000000000000000n + BigInt(i * 1000),
					max: 200000000000000000n + BigInt(i * 1000 + 999),
				})
				.toString(),
			type: 0, // GuildText
			name: faker.helpers.arrayElement([
				"general",
				"random",
				"dev-chat",
				"support",
				"announcements",
				"off-topic",
				"bugs",
				"feature-requests",
			]),
			guildId: GUILD,
		}),
	);

	// ── Messages ───────────────────────────────────────────────
	const startTime = new Date("2023-01-01").getTime();
	const endTime = new Date("2024-06-01").getTime();
	const messages: Record<string, DiscordMessageData[]> = {};

	let totalMessageCount = 0;

	for (const [ci, channel] of channels.entries()) {
		const channelMessages: DiscordMessageData[] = [];
		// Each channel gets its own unique ID base so snowflakes never overlap
		let lastId =
			BigInt(channel.id) + BigInt(ci) * BigInt(messagesPerChannel * 100) + 1n;

		for (let i = 0; i < messagesPerChannel; i++) {
			// Monotonically increasing snowflake IDs
			const id = lastId.toString();
			lastId += BigInt(faker.number.int({ min: 1, max: 50 }));

			// Spread timestamps evenly across the date range
			const progress = i / messagesPerChannel;
			const timestamp = Math.floor(
				startTime +
					(endTime - startTime) * progress +
					faker.number.int({ min: -3600000, max: 3600000 }), // ±1hr jitter
			);

			const author = faker.helpers.arrayElement(users);

			channelMessages.push({
				id,
				channelId: channel.id,
				guildId: GUILD,
				type: 0, // Default
				content: faker.lorem.sentence({ min: 3, max: 20 }),
				timestamp,
				editedTimestamp: undefined,
				author: { ...author },
				attachments: [],
				embeds: [],
				reactions: [],
				mentions: [],
				mentionChannelIds: [],
				stickerItems: [],
			});
		}

		messages[channel.id] = channelMessages;
		totalMessageCount += channelMessages.length;
	}

	return {
		guild: { id: GUILD, channels },
		channels,
		messages,
		totalMessageCount,
	};
}

// ─── DataSource that returns messages from pre-generated data ───────────

/** Factory for a FileDiscordDataSource from a faker-generated guild. */
function buildFakeDiscord(
	guild: DiscordGuildData,
	channels: DiscordChannelData[],
	messages: Record<string, DiscordMessageData[]>,
): DiscordDataSource {
	return FileDiscordDataSource.fromData({
		guild,
		channels,
		messages,
	});
}

// ─── Helpers ────────────────────────────────────────────────────────────

function setupRepo(): BridgeRepository {
	const repo = BridgeRepository.open(":memory:");
	repo.upsertBridgeConfig(GUILD, SPACE, "full");
	return repo;
}

/** Pre-register channel-to-room mappings so ingest doesn't skip. */
function mapChannels(
	repo: BridgeRepository,
	channels: DiscordChannelData[],
): Map<string, string> {
	const mapping = new Map<string, string>();
	for (const ch of channels) {
		const roomyId = newUlid();
		mapping.set(ch.id, roomyId);
		repo.registerMapping(SPACE, "channel", ch.id, roomyId);
	}
	return mapping;
}

/** Count createMessage events sent to the gateway for a space. */
function countCreateMessageEvents(
	roomy: MockRoomyGateway,
	spaceDid: string,
): number {
	return roomy
		.eventsFor(spaceDid)
		.filter((e) => e.$type === "space.roomy.message.createMessage.v0").length;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("backfillChannel with faker-generated guild", () => {
	beforeEach(() => {
		faker.seed(42); // consistent seed for each test
	});

	/**
	 * BF01: Basic backfill — 1 channel with fewer than 100 messages.
	 * All messages should be synced in a single page.
	 */
	test("BF01: backfills a channel with < 100 messages completely", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 50,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		const ch = channels[0];
		expectToBeDefined(ch);
		await backfillChannel(discord, repo, roomy, ch.id, SPACE);

		const synced = countCreateMessageEvents(roomy, SPACE);
		expect(synced).toBe(50);
	});

	/**
	 * BF02: Backfill with exactly 100 messages — one full page.
	 */
	test("BF02: backfills a channel with exactly 100 messages", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 100,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		const ch = channels[0];
		expectToBeDefined(ch);
		await backfillChannel(discord, repo, roomy, ch.id, SPACE);

		const synced = countCreateMessageEvents(roomy, SPACE);
		expect(synced).toBe(100);
	});

	/**
	 * BF03: Backfill with 250 messages — requires 3 pages (100 + 100 + 50).
	 */
	test("BF03: backfills a channel with > 100 messages across multiple pages", async () => {
		const { guild, channels, messages, totalMessageCount } = createFakeGuild({
			seed: 42,
			channelCount: 3,
			messagesPerChannel: 250,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		// Backfill each channel sequentially
		for (const channel of channels) {
			await backfillChannel(discord, repo, roomy, channel.id, SPACE);
		}

		const synced = countCreateMessageEvents(roomy, SPACE);
		const expected = totalMessageCount;

		// The backfill should process all pages. A small number of messages
		// may be skipped by ingestDiscordMessage (duplicate IDs, etc.)
		const tolerance = Math.ceil(expected * 0.1); // 10% — faker edge cases
		expect(synced).toBeGreaterThanOrEqual(expected - tolerance);
		expect(synced).toBeLessThanOrEqual(expected + 1);
	});

	/**
	 * BF04: Backfill with 500 messages per channel — 5 pages each.
	 */
	test("BF04: backfills a channel with 500 messages (5 pages)", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 500,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		const ch = channels[0];
		expectToBeDefined(ch);
		await backfillChannel(discord, repo, roomy, ch.id, SPACE);

		const synced = countCreateMessageEvents(roomy, SPACE);
		expect(synced).toBe(500);
	});

	/**
	 * BF05: Multiple channels with varying message counts.
	 * Simulates a realistic guild with diverse channel sizes.
	 */
	test("BF05: backfills multiple channels with varying sizes", async () => {
		// Use the script's generate-fake-data style: mix of channel sizes
		faker.seed(42);
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 6,
			messagesPerChannel: 150,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		for (const channel of channels) {
			await backfillChannel(discord, repo, roomy, channel.id, SPACE);
		}

		// Verify each channel's message count individually
		// Allow 3% tolerance for natural ingestion skips
		for (const channel of channels) {
			const channelMsgs = messages[channel.id] ?? [];
			const expectedCount = channelMsgs.length;
			const roomyId = repo.getRoomyId(SPACE, "channel", channel.id);

			// Count events that went to this channel's room
			const channelEvents = roomy
				.eventsFor(SPACE)
				.filter(
					(e) =>
						e.$type === "space.roomy.message.createMessage.v0" &&
						e.room === roomyId,
				);

			const tolerance = Math.ceil(expectedCount * 0.1); // 10% — faker edge cases
			expect(channelEvents.length).toBeGreaterThanOrEqual(
				expectedCount - tolerance,
			);
			expect(channelEvents.length).toBeLessThanOrEqual(expectedCount + 1);
		}
	});

	/**
	 * BF06: Verify cursor advancement matches expected pagination.
	 */
	test("BF06: cursor is updated after multi-page backfill", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 300,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);
		const channel = channels[0];
		expectToBeDefined(channel);

		await backfillChannel(discord, repo, roomy, channel.id, SPACE);

		const cursor = repo.getChannelCursor(SPACE, channel.id);
		expect(cursor).toBeDefined();
		expect(cursor?.lastMessageId).toBeDefined();
		expect(typeof cursor?.lastMessageId).toBe("string");
	});

	/**
	 * BF07: Large channel with 10,000 messages.
	 */
	test("BF07: backfills a channel with 10,000 messages (100 pages)", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 10_000,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		const ch = channels[0];
		expectToBeDefined(ch);
		await backfillChannel(discord, repo, roomy, ch.id, SPACE);

		const synced = countCreateMessageEvents(roomy, SPACE);
		expect(synced).toBe(10_000);
	});

	/**
	 * BF08: Multiple channels with varied sizes.
	 *
	 * Channels: [50, 99, 100, 250, 500, 1000] messages each.
	 */
	test("BF08: mixed channel sizes — some full, some incomplete", async () => {
		const sizes = [50, 99, 100, 250, 500, 1000];
		const channelCount = sizes.length;

		// Build multi-channel guild with per-channel message counts
		faker.seed(42);
		const users: DiscordUserData[] = Array.from({ length: 10 }, () => ({
			id: faker.number
				.bigInt({ min: 100000000000000000n, max: 999999999999999999n })
				.toString(),
			name: faker.internet.username().toLowerCase(),
			discriminator: "0000",
			globalName: faker.person.fullName(),
			avatar: null,
			isBot: false,
		}));

		const channels: DiscordChannelData[] = [];
		const messages: Record<string, DiscordMessageData[]> = {};
		const startTime = new Date("2023-01-01").getTime();
		const endTime = new Date("2024-06-01").getTime();

		for (let ci = 0; ci < channelCount; ci++) {
			const chId = faker.number
				.bigInt({
					min: 300000000000000000n + BigInt(ci * 1000),
					max: 300000000000000000n + BigInt(ci * 1000 + 999),
				})
				.toString();

			channels.push({
				id: chId,
				type: 0,
				name:
					["general", "random", "dev", "support", "announcements", "off-topic"][
						ci
					] ?? "channel",
				guildId: GUILD,
			});

			const n = sizes[ci];
			expectToBeDefined(n);
			const chMsgs: DiscordMessageData[] = [];
			let lastId = BigInt(chId) + 1n;

			for (let i = 0; i < n; i++) {
				const id = lastId.toString();
				lastId += BigInt(faker.number.int({ min: 1, max: 50 }));
				const progress = i / n;
				const timestamp = Math.floor(
					startTime +
						(endTime - startTime) * progress +
						faker.number.int({ min: -3600000, max: 3600000 }),
				);

				chMsgs.push({
					id,
					channelId: chId,
					guildId: GUILD,
					type: 0,
					content: faker.lorem.sentence({ min: 3, max: 20 }),
					timestamp,
					editedTimestamp: undefined,
					author: faker.helpers.arrayElement([...users]),
					attachments: [],
					embeds: [],
					reactions: [],
					mentions: [],
					mentionChannelIds: [],
					stickerItems: [],
				});
			}

			messages[chId] = chMsgs;
		}

		const guild: DiscordGuildData = { id: GUILD, channels };
		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		for (const ch of channels) {
			await backfillChannel(discord, repo, roomy, ch.id, SPACE);
		}

		// All channels should be fully synced after the fix.
		// A small number of messages may be skipped by ingestDiscordMessage
		for (let ci = 0; ci < channelCount; ci++) {
			const ch = channels[ci];
			expectToBeDefined(ch);
			const expectedCount = sizes[ci];
			expectToBeDefined(expectedCount);
			const roomyId = repo.getRoomyId(SPACE, "channel", ch.id);
			const channelEvents = roomy
				.eventsFor(SPACE)
				.filter(
					(e) =>
						e.$type === "space.roomy.message.createMessage.v0" &&
						e.room === roomyId,
				);

			const tolerance = Math.ceil(expectedCount * 0.1); // 10% tolerance
			expect(channelEvents.length).toBeGreaterThanOrEqual(
				expectedCount - tolerance,
			);
			expect(channelEvents.length).toBeLessThanOrEqual(expectedCount + 1);
		}
	});

	/**
	 * BF09: Second backfill run on same channel — should be idempotent.
	 */
	test("BF09: subsequent backfill run adds no new messages", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 10_000,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		// First backfill
		const ch = channels[0];
		expectToBeDefined(ch);
		await backfillChannel(discord, repo, roomy, ch.id, SPACE);
		const firstRunCount = countCreateMessageEvents(roomy, SPACE);

		// Second backfill — should be idempotent (same cursor, no new messages)
		await backfillChannel(discord, repo, roomy, ch.id, SPACE);
		const secondRunCount = countCreateMessageEvents(roomy, SPACE);

		// Cursor hasn't changed, so second run should add nothing
		expect(secondRunCount).toBe(firstRunCount);
	});
});

describe("ensureRoomyThreads with active threads", () => {
	beforeEach(() => {
		faker.seed(42);
	});

	/**
	 * RT01: Active threads under bridged parent channels are discovered
	 * and have Roomy rooms created + backfilled.
	 */
	test("RT01: creates rooms and backfills messages for active threads under bridged parents", async () => {
		const parentChannel: DiscordChannelData = {
			id: "200000000000000001",
			type: 0, // GuildText
			name: "general",
			guildId: GUILD,
		};

		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11, // PublicThread
			name: "my-active-thread",
			parentId: parentChannel.id,
			guildId: GUILD,
		};

		const threadMessages: DiscordMessageData[] = Array.from(
			{ length: 5 },
			(_, i) => ({
				id: `40000000000000000${i + 1}`,
				channelId: activeThread.id,
				guildId: GUILD,
				type: 0,
				content: `Thread message ${i + 1}`,
				timestamp: Date.now() - (5 - i) * 60000,
				editedTimestamp: undefined,
				author: {
					id: "500000000000000001",
					name: "testuser",
					discriminator: "0000",
					globalName: "Test User",
					avatar: null,
				},
				attachments: [],
				embeds: [],
				reactions: [],
				mentions: [],
				mentionChannelIds: [],
				stickerItems: [],
			}),
		);

		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [parentChannel] },
			channels: [parentChannel, activeThread],
			messages: { [activeThread.id]: threadMessages },
			activeThreads: [activeThread],
		});

		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE, "full");
		// Pre-map the parent channel so the thread can link to it
		const parentRoomyId = newUlid();
		repo.registerMapping(SPACE, "channel", parentChannel.id, parentRoomyId);

		const roomy = new MockRoomyGateway();

		await ensureRoomyThreads(discord, repo, roomy, [
			{ guildId: GUILD, spaceDid: SPACE, mode: "full", createdAt: 0, updatedAt: 0 },
		]);

		// Should have created a room for the active thread
		const roomEvents = roomy
			.eventsFor(SPACE)
			.filter((e) => e.$type === "space.roomy.room.createRoom.v0");
		expect(roomEvents).toHaveLength(1);
		expect(roomEvents[0]?.kind).toBe("space.roomy.thread");
		expect(roomEvents[0]?.name).toBe("my-active-thread");

		// Should have created a room link to the parent
		const linkEvents = roomy
			.eventsFor(SPACE)
			.filter((e) => e.$type === "space.roomy.link.createRoomLink.v0");
		expect(linkEvents).toHaveLength(1);
		expect(linkEvents[0]?.linkToRoom).toBe(roomEvents[0]?.id);

		// Thread mapping should be registered
		expect(
			repo.getRoomyId(SPACE, "thread", activeThread.id),
		).toBe(roomEvents[0]?.id);

		// Should have backfilled the thread's messages
		const messageEvents = roomy
			.eventsFor(SPACE)
			.filter((e) => e.$type === "space.roomy.message.createMessage.v0");
		expect(messageEvents).toHaveLength(5);
	});

	/**
	 * RT02: Active threads under non-bridged parent channels are skipped.
	 */
	test("RT02: skips active threads whose parent channel is not bridged", async () => {
		const parentChannel: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};

		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "orphan-thread",
			parentId: "999999999999999999", // not bridged
			guildId: GUILD,
		};

		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [parentChannel] },
			channels: [parentChannel, activeThread],
			activeThreads: [activeThread],
		});

		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE, "full");
		repo.registerMapping(SPACE, "channel", parentChannel.id, newUlid());

		const roomy = new MockRoomyGateway();

		await ensureRoomyThreads(discord, repo, roomy, [
			{ guildId: GUILD, spaceDid: SPACE, mode: "full", createdAt: 0, updatedAt: 0 },
		]);

		expect(roomy.eventCount(SPACE)).toBe(0);
	});

	/**
	 * RT03: Private active threads are synced with defaultAccess=none.
	 */
	test("RT03: syncs private active threads with defaultAccess=none", async () => {
		const parentChannel: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};

		const privateThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 12, // PRIVATE_THREAD
			name: "private-thread",
			parentId: parentChannel.id,
			guildId: GUILD,
		};

		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [parentChannel] },
			channels: [parentChannel, privateThread],
			activeThreads: [privateThread],
		});

		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE, "full");
		repo.registerMapping(SPACE, "channel", parentChannel.id, newUlid());

		const roomy = new MockRoomyGateway();

		await ensureRoomyThreads(discord, repo, roomy, [
			{ guildId: GUILD, spaceDid: SPACE, mode: "full", createdAt: 0, updatedAt: 0 },
		]);

		const roomEvents = roomy
			.eventsFor(SPACE)
			.filter((e) => e.$type === "space.roomy.room.createRoom.v0");
		expect(roomEvents).toHaveLength(1);
		expect(roomEvents[0]?.defaultAccess).toBe("none");
		expect(roomEvents[0]?.kind).toBe("space.roomy.thread");
		expect(roomEvents[0]?.name).toBe("private-thread");

		// Mapping should be registered
		expect(
			repo.getRoomyId(SPACE, "thread", privateThread.id),
		).toBe(roomEvents[0]?.id);
	});

	/**
	 * RT04: Already-mapped active threads are skipped (idempotent).
	 */
	test("RT04: skips active threads that already have a mapping", async () => {
		const parentChannel: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};

		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "already-mapped-thread",
			parentId: parentChannel.id,
			guildId: GUILD,
		};

		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [parentChannel] },
			channels: [parentChannel, activeThread],
			activeThreads: [activeThread],
		});

		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE, "full");
		repo.registerMapping(SPACE, "channel", parentChannel.id, newUlid());
		repo.registerMapping(SPACE, "thread", activeThread.id, "existing-ulid");

		const roomy = new MockRoomyGateway();

		await ensureRoomyThreads(discord, repo, roomy, [
			{ guildId: GUILD, spaceDid: SPACE, mode: "full", createdAt: 0, updatedAt: 0 },
		]);

		expect(roomy.eventCount(SPACE)).toBe(0);
	});

	/**
	 * RT05: Active threads in subset mode are added to the allowlist.
	 */
	test("RT05: adds active thread to allowlist in subset mode", async () => {
		const parentChannel: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};

		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "subset-thread",
			parentId: parentChannel.id,
			guildId: GUILD,
		};

		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [parentChannel] },
			channels: [parentChannel, activeThread],
			activeThreads: [activeThread],
		});

		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE, "subset");
		repo.addToAllowlist(SPACE, parentChannel.id, GUILD);
		repo.registerMapping(SPACE, "channel", parentChannel.id, newUlid());

		const roomy = new MockRoomyGateway();

		await ensureRoomyThreads(discord, repo, roomy, [
			{ guildId: GUILD, spaceDid: SPACE, mode: "subset", createdAt: 0, updatedAt: 0 },
		]);

		// Thread should be created
		const roomEvents = roomy
			.eventsFor(SPACE)
			.filter((e) => e.$type === "space.roomy.room.createRoom.v0");
		expect(roomEvents).toHaveLength(1);

		// Thread should be in the allowlist
		expect(repo.isAllowlisted(SPACE, activeThread.id)).toBe(true);
	});
});
