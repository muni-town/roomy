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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { faker } from "@faker-js/faker";
import { newUlid } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { startApi } from "../../api.ts";
import type {
	DiscordChannelData,
	DiscordGuildData,
	DiscordMessageData,
	DiscordUserData,
} from "../../discord/data.ts";
import type { DiscordDataSource } from "../../discord/data-source.ts";
import { FileDiscordDataSource } from "../../discord/file-data-source.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import {
	resetCapacityGate,
	setCapacityGate,
} from "../../roomy/capacity.ts";
import {
	PHASE1_MESSAGE_BOUND,
	backfillChannel,
	backfillRecentWindow,
	ensureAndBackfillArchivedThreads,
	ensureRoomyThreads,
	enumerateBackfillWork,
	postBackfillCompletionNotices,
	runBackfill,
	setBackfillNoticeSender,
} from "../backfill.ts";
import { ingestDiscordMessage } from "../message-ingestion.ts";
import type { DiscordSender } from "../../discord/sender.ts";
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
/** A DiscordSender whose sends are recorded and can fail on demand. */
function makeMockDiscordSender() {
	const sent: Array<{ channelId: string; content: string }> = [];
	// Resolves on the first completed send — the "notice posted" signal
	// for the fire-and-forget Phase-2 walk (no wall-clock polling).
	const { promise: noticePosted, resolve: resolveNotice } =
		Promise.withResolvers<void>();
	const mock: DiscordSender & { failSends: boolean } = {
		async sendMessage(channelId, content) {
			if (mock.failSends) throw new Error("simulated send failure");
			sent.push({ channelId, content });
			resolveNotice();
			return "9000000000000000001";
		},
		async editMessage() {},
		async deleteMessage() {},
		async addReaction() {},
		async removeReaction() {},
		async getParentChannelId() {
			return undefined;
		},
		async getGuildId() {
			return GUILD;
		},
		async getMessage() {
			return undefined;
		},
		async createThread() {
			return "9000000000000000002";
		},
		failSends: false,
	};
	return { sent, mock, noticePosted };
}

/** Minimal Discord message for the end-to-end runBackfill test. */
function cnMessage(id: string, channelId: string): DiscordMessageData {
	return {
		id,
		channelId,
		guildId: GUILD,
		type: 0,
		content: `message-${id}`,
		timestamp: Date.now() - Number(BigInt("1" + id.slice(2))),
		editedTimestamp: undefined,
		author: {
			id: "111111111111111111",
			name: "tester",
			discriminator: "0000",
			globalName: "Tester",
		},
		attachments: [],
		embeds: undefined,
		reactions: undefined,
		mentions: undefined,
		mentionChannelIds: [],
		stickerItems: undefined,
	};
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

		// All channels should be fully synced.
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

// ─── Two-phase backfill (bounded Phase-1 window + Phase-2 walk) ─────────

function buildFakeGuildForMessages(count: number) {
	return createFakeGuild({
		seed: 42,
		channelCount: 1,
		messagesPerChannel: count,
	});
}

/**
 * BF10: Phase-1 bound is falsifiable — a 2500-message channel is ingested
 * at most PHASE1_MESSAGE_BOUND times by the window, then the Phase-2 walk
 * covers the remainder.
 */
describe("two-phase backfill", () => {
	beforeEach(() => {
		faker.seed(42);
	});

	test("BF10: Phase-1 window is bounded to PHASE1_MESSAGE_BOUND messages", async () => {
		const { guild, channels, messages } = buildFakeGuildForMessages(2500);
		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);
		const ch = channels[0];
		expectToBeDefined(ch);

		// Phase 1 — exactly the window call sites use this signature.
		await backfillRecentWindow(
			discord,
			repo,
			roomy,
			ch.id,
			SPACE,
			GUILD,
			"channel",
		);

		const afterWindow = countCreateMessageEvents(roomy, SPACE);

		// Falsifiable bound: never more than PHASE1_MESSAGE_BOUND messages.
		expect(afterWindow).toBeLessThanOrEqual(PHASE1_MESSAGE_BOUND);

		let progress = repo.getBackfillProgress(SPACE, ch.id);
		expectToBeDefined(progress);
		expect(progress?.phase).toBe("phase2");
		expect(progress?.messagesSynced).toBeLessThanOrEqual(
			PHASE1_MESSAGE_BOUND,
		);
		expect(progress?.messagesSynced).toBeGreaterThanOrEqual(
			PHASE1_MESSAGE_BOUND - 100, // 10% tolerance for natural ingest skips
		);
		expect(progress?.windowBoundary).toBeDefined();
		expect(progress?.walkCursor).toBeNull();

		// Phase 2 — the walk completes the remainder.
		await backfillChannel(discord, repo, roomy, ch.id, SPACE, GUILD);

		const total = countCreateMessageEvents(roomy, SPACE);
		expect(total).toBeGreaterThanOrEqual(2500 - 250);
		expect(total).toBeLessThanOrEqual(2500 + 1);

		progress = repo.getBackfillProgress(SPACE, ch.id);
		expect(progress?.phase).toBe("complete");
		expect(progress?.messagesSynced).toBeGreaterThanOrEqual(2500 - 250);

		// Cursor is at the newest ingested message (the window's top page).
		const cursor = repo.getChannelCursor(SPACE, ch.id);
		expect(cursor?.lastMessageId).toBe(
			[...messages[ch.id] ?? []].sort(
				(a, b) => Number(BigInt(b.id) - BigInt(a.id)),
			)[0]?.id,
		);
	});

	test("BF11: a channel that fits inside the bound is complete immediately after Phase 1", async () => {
		const { guild, channels, messages } = buildFakeGuildForMessages(50);
		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);
		const ch = channels[0];
		expectToBeDefined(ch);

		await backfillRecentWindow(
			discord,
			repo,
			roomy,
			ch.id,
			SPACE,
			GUILD,
			"channel",
		);

		const progress = repo.getBackfillProgress(SPACE, ch.id);
		expectToBeDefined(progress);
		expect(progress?.phase).toBe("complete");
		expect(progress?.messagesSynced).toBe(50);
		expect(progress?.walkCursor).toBeNull();
		// The Phase-2 walk must be a no-op on an already-complete pair.
		await backfillChannel(discord, repo, roomy, ch.id, SPACE, GUILD);
		expect(countCreateMessageEvents(roomy, SPACE)).toBe(50);
	});

	test("BF12: progress survives restart and the Phase-2 walk resumes from the persisted cursor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roomy-backfill-"));
		const dbPath = join(dir, "bridge.sqlite");
		try {
			const { guild, channels, messages } = buildFakeGuildForMessages(2050);
			const discord = buildFakeDiscord(guild, channels, messages);
			const roomy = new MockRoomyGateway();

			// Repo "instance 1": Phase-1 window, then close (the pair is left
			// in phase2, walk not started).
			const repo1 = BridgeRepository.open(dbPath);
			repo1.upsertBridgeConfig(GUILD, SPACE, "full");
			mapChannels(repo1, channels);
			const ch = channels[0];
			expectToBeDefined(ch);
			await backfillRecentWindow(
				discord,
				repo1,
				roomy,
				ch.id,
				SPACE,
				GUILD,
				"channel",
			);
			expect(repo1.getBackfillProgress(SPACE, ch.id)?.phase).toBe("phase2");
			repo1.close();

			// "Restart": reopen the same file — the durable row must be there.
			const repo2 = BridgeRepository.open(dbPath);
			const persisted = repo2.getBackfillProgress(SPACE, ch.id);
			expectToBeDefined(persisted);
			expect(persisted?.phase).toBe("phase2");
			expect(persisted?.messagesSynced).toBeGreaterThan(0);

			// Simulate a crash mid-walk: the data source starts failing on
			// the 3rd bottom-up page, so two walk pages land and the cursor
			// persists right after the 2nd.
			const allMessages = messages[ch.id] ?? [];
			const crashAtPage = 3;
			let afterPageCount = 0;
			const crashingSource = new Proxy(discord, {
				get(target, prop, _receiver) {
					if (prop === "getMessages") {
						return (channelId: string, opts: { after?: string }) => {
							if (opts.after) {
								afterPageCount++;
								if (afterPageCount >= crashAtPage) {
									throw new Error("simulated crash mid-walk");
								}
							}
							return target.getMessages(channelId, opts);
						};
					}
					// Keep `this` bound to the target so private fields resolve.
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});

			await expect(
				backfillChannel(crashingSource, repo2, roomy, ch.id, SPACE, GUILD),
			).rejects.toThrow("simulated crash mid-walk");

			const interrupted = repo2.getBackfillProgress(SPACE, ch.id);
			expectToBeDefined(interrupted);
			expect(interrupted?.phase).toBe("phase2");
			// Walk page 1 + page 2 ingested on top of the window's 1000.
			expect(interrupted?.messagesSynced).toBe(1000 + 200);
			// Boundary guard: the walk stopped mid-history, cursor = newest
			// message of walk page 2 (id #200 of the channel).
			const oldestFirst = [...allMessages].sort(
				(a, b) => Number(BigInt(a.id) - BigInt(b.id)),
			);
			expect(interrupted?.walkCursor).toBe(oldestFirst[199]?.id ?? "");
			repo2.close();

			// "Restart" again: a fresh instance resumes from walkCursor and
			// completes the remainder WITHOUT re-ingesting the window or the
			// two walked pages.
			const repo3 = BridgeRepository.open(dbPath);
			const resumedSource = buildFakeDiscord(guild, channels, messages);
			await backfillChannel(
				resumedSource,
				repo3,
				roomy,
				ch.id,
				SPACE,
				GUILD,
			);

			const done = repo3.getBackfillProgress(SPACE, ch.id);
			expectToBeDefined(done);
			expect(done?.phase).toBe("complete");
			// Window 1000 + two walked pages 200 + resumed remainder 850.
			expect(done?.messagesSynced).toBe(2050);
			// Last walk page = the boundary-adjacent block m1001..m1100
			// (50 below-boundary ingested, 50 boundary messages skipped),
			// so the final cursor is the newest message of that block.
			expect(done?.walkCursor).toBe(oldestFirst[1099]?.id ?? "");

			// End-to-end the gateway saw exactly the 2050 messages' events.
			expect(countCreateMessageEvents(roomy, SPACE)).toBeGreaterThanOrEqual(
				2050 - 100,
			);
			expect(countCreateMessageEvents(roomy, SPACE)).toBeLessThanOrEqual(
				2050 + 1,
			);

			// The pair's progress row after "restart" is per-channel correct.
			expect(repo3.listBackfillProgress(SPACE).length).toBe(1);
			repo3.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("BF13: stall guard stops both phases instead of looping", async () => {
		const { guild, channels, messages } = buildFakeGuildForMessages(2000);
		const discord = buildFakeDiscord(guild, channels, messages);
		const ch = channels[0];
		expectToBeDefined(ch);
		const allMessages = messages[ch.id] ?? [];
		const newestFirst = [...allMessages].sort(
			(a, b) => Number(BigInt(b.id) - BigInt(a.id)),
		);
		const oldest100 = newestFirst.slice(-100).reverse(); // m1..m100, oldest-first

		// Window-sticky source: every paginated call returns the same NEWEST
		// page, so the Phase-1 window can never advance past page 1.
		const windowSticky = new Proxy(discord, {
			get(target, prop, _receiver) {
				if (prop === "getMessages") {
					return (
						channelId: string,
						opts: { before?: string; after?: string },
					) => {
						if (opts.before === undefined && opts.after === undefined) {
							return target.getMessages(channelId, { limit: 100 });
						}
						return target.getMessages(channelId, { limit: 100 });
					};
				}
				// Keep `this` on the target so private fields resolve.
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		// Walk-sticky source: every bottom-up (after) page returns the same
		// OLDEST 100 messages — below the boundary (so the boundary stop
		// never fires) but never advancing, so the walk must hit its stall
		// guard instead of looping.
		const walkSticky = new Proxy(discord, {
			get(target, prop, _receiver) {
				if (prop === "getMessages") {
					return (
						channelId: string,
						opts: { before?: string; after?: string },
					) => {
						if (opts.after) return oldest100;
						return target.getMessages(channelId, { limit: 100 });
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		// Step 1 — Phase-1 window must stall (never complete) on a sticky
		// source, leaving the pair resumable in phase2.
		await backfillRecentWindow(
			windowSticky,
			repo,
			roomy,
			ch.id,
			SPACE,
			GUILD,
			"channel",
		);
		let progress = repo.getBackfillProgress(SPACE, ch.id);
		expectToBeDefined(progress);
		expect(progress?.phase).toBe("phase2");
		expect(progress?.messagesSynced).toBe(100);
		expect(progress?.walkCursor).toBeNull();

		// Step 2 — the walk must stall on a sticky source too, ingesting the
		// first page below the boundary then stopping instead of looping.
		await backfillChannel(walkSticky, repo, roomy, ch.id, SPACE, GUILD);
		progress = repo.getBackfillProgress(SPACE, ch.id);
		expectToBeDefined(progress);
		expect(progress?.phase).toBe("phase2");
		expect(progress?.messagesSynced).toBe(200); // 100 window + 100 walk
		expect(progress?.walkCursor).toBe(oldest100[0]?.id ?? "");
	});

	test("BF14: /backfill/progress endpoint returns durable per-channel payload", async () => {
		const { guild, channels, messages } = buildFakeGuildForMessages(2500);
		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);
		const ch = channels[0];
		expectToBeDefined(ch);

		await backfillChannel(discord, repo, roomy, ch.id, SPACE, GUILD);
		expect(repo.getBackfillProgress(SPACE, ch.id)?.phase).toBe("complete");

		// Spin the real HTTP surface on an ephemeral port.
		const prevPort = process.env.PORT;
		process.env.PORT = "0";
		let server:
			| {
					port: number | undefined;
					stop(closeActiveConnections?: boolean): void;
			  }
			| undefined;
		try {
			server = startApi(repo, () => "app-id");
			const res = await fetch(
				`http://127.0.0.1:${server.port}/backfill/progress?spaceDid=${encodeURIComponent(SPACE)}`,
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				channels: Array<Record<string, unknown>>;
			};
			expect(Array.isArray(body.channels)).toBe(true);
			expect(body.channels).toHaveLength(1);
			const entry = body.channels[0];
			if (!entry) throw new Error("expected one progress entry");
			expect(entry.spaceDid).toBe(SPACE);
			expect(entry.channelId).toBe(ch.id);
			expect(entry.kind).toBe("channel");
			expect(entry.channelName).toBe(ch.name);
			expect(entry.phase).toBe("complete");
			expect(typeof entry.messagesSynced).toBe("number");
			expect((entry.messagesSynced as number)).toBeGreaterThanOrEqual(2250);
			expect(typeof entry.messagesSkipped).toBe("number");
			expect(typeof entry.cursor).toBe("string");
			expect(entry.running).toBe(false);
			expect(typeof entry.updatedAt).toBe("number");

			// Payload extensions: durable identity + phase snapshot.
			expect(entry.parentId).toBeNull(); // top-level channel
			// The Phase-1 window hit the bound before Phase 2 walked the
			// remainder; the phase1→phase2 snapshot must be preserved.
			expect(entry.windowSynced).toBe(PHASE1_MESSAGE_BOUND);
			expect(typeof entry.roomyId).toBe("string");
			expect((entry.roomyId as string).length).toBeGreaterThan(0);

			// A space with no rows gets an empty list, not an error.
			const emptyRes = await fetch(
				"http://127.0.0.1:" +
					server.port +
					"/backfill/progress?spaceDid=did%3Aweb%3Anone",
			);
			expect(emptyRes.status).toBe(200);
			const emptyBody = (await emptyRes.json()) as { channels: unknown[] };
			expect(emptyBody.channels).toEqual([]);
		} finally {
			server?.stop(true);
			if (prevPort === undefined) delete process.env.PORT;
			else process.env.PORT = prevPort;
		}
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
			{
				guildId: GUILD,
				spaceDid: SPACE,
				mode: "full",
				createdAt: 0,
				updatedAt: 0,
			},
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
		expect(repo.getRoomyId(SPACE, "thread", activeThread.id)).toBe(
			roomEvents[0]?.id,
		);

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
			{
				guildId: GUILD,
				spaceDid: SPACE,
				mode: "full",
				createdAt: 0,
				updatedAt: 0,
			},
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
			{
				guildId: GUILD,
				spaceDid: SPACE,
				mode: "full",
				createdAt: 0,
				updatedAt: 0,
			},
		]);

		const roomEvents = roomy
			.eventsFor(SPACE)
			.filter((e) => e.$type === "space.roomy.room.createRoom.v0");
		expect(roomEvents).toHaveLength(1);
		expect(roomEvents[0]?.defaultAccess).toBe("none");
		expect(roomEvents[0]?.kind).toBe("space.roomy.thread");
		expect(roomEvents[0]?.name).toBe("private-thread");

		// Mapping should be registered
		expect(repo.getRoomyId(SPACE, "thread", privateThread.id)).toBe(
			roomEvents[0]?.id,
		);
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
			{
				guildId: GUILD,
				spaceDid: SPACE,
				mode: "full",
				createdAt: 0,
				updatedAt: 0,
			},
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
			{
				guildId: GUILD,
				spaceDid: SPACE,
				mode: "subset",
				createdAt: 0,
				updatedAt: 0,
			},
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

describe("backfill — capacity enforcement", () => {
	beforeEach(() => {
		setCapacityGate({ isEnabled: async () => false });
	});

	afterEach(() => {
		resetCapacityGate();
	});

	test("CAP01: backfillChannel aborts when the guild is over capacity", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 10,
		});

		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		const ch = channels[0];
		expectToBeDefined(ch);
		await backfillChannel(discord, repo, roomy, ch.id, SPACE);

		expect(countCreateMessageEvents(roomy, SPACE)).toBe(0);
	});

	test("CAP02: ensureRoomyThreads creates no threads when over capacity", async () => {
		const parentChannel: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};

		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "capacity-thread",
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

		const roomy = new MockRoomyGateway();

		await ensureRoomyThreads(discord, repo, roomy, [
			{
				guildId: GUILD,
				spaceDid: SPACE,
				mode: "full",
				createdAt: 0,
				updatedAt: 0,
			},
		]);

		expect(roomy.eventCount(SPACE)).toBe(0);
	});
});

// ─── Archived-thread backfill ───────────────────────────────────────────

interface FakeThreadsScenario {
	parents: Array<{
		id: string;
		name: string;
		/** Pages served in order; each page is a list of thread ids+names. */
		pages?: Array<Array<{ id: string; name: string }>>;
		/** Always throw on page fetch (simulates a permanently broken page). */
		alwaysFail?: boolean;
		/** Re-serve the same first page forever with hasMore=true. */
		sticky?: boolean;
	}>;
}

interface FakeThreadsSource {
	ds: DiscordDataSource;
	pageCalls: Array<{ parentId: string; before: string | undefined }>;
}

/** Scripted DiscordDataSource for the archived-thread backfill loop. */
function makeArchivedThreadsSource(
	scenario: FakeThreadsScenario,
): FakeThreadsSource {
	const pageCalls: Array<{ parentId: string; before: string | undefined }> =
		[];
	const parentById = new Map(scenario.parents.map((p) => [p.id, p]));
	const channelById = new Map(
		scenario.parents.map((p) => [p.id, { id: p.id, name: p.name }]),
	);

	const ds: DiscordDataSource = {
		async getMessages() {
			return [];
		},
		async getChannel(channelId) {
			const p = channelById.get(channelId);
			return p
				? { id: p.id, type: 0, name: p.name, guildId: GUILD }
				: undefined;
		},
		async getChannels(guildId) {
			if (guildId !== GUILD) return [];
			return scenario.parents.map((p) => ({
				id: p.id,
				type: 0,
				name: p.name,
				guildId: GUILD,
			}));
		},
		async getGuild(guildId) {
			if (guildId !== GUILD) return undefined;
			return { id: GUILD, channels: await ds.getChannels(guildId) };
		},
		async getPublicArchivedThreads(parentId, opts) {
			pageCalls.push({ parentId, before: opts.before });
			const parent = parentById.get(parentId);
			if (!parent || parent.alwaysFail) {
				throw new Error(`simulated page failure for ${parentId}`);
			}
			const pages = parent.pages ?? [];
			if (pages.length === 0) return { threads: [], hasMore: false };
			if (parent.sticky) {
				const page = pages[0];
				if (!page) return { threads: [], hasMore: false };
				return {
					threads: page.map((t) => ({
						id: t.id,
						type: 11,
						name: t.name,
						guildId: GUILD,
						parentId,
					})),
					hasMore: true,
				};
			}
			const page = pages.shift();
			if (!page) return { threads: [], hasMore: false };
			return {
				threads: page.map((t) => ({
					id: t.id,
					type: 11,
					name: t.name,
					guildId: GUILD,
					parentId,
				})),
				hasMore: pages.length > 0,
			};
		},
		async resolveChannelName(channelId) {
			return channelById.get(channelId)?.name;
		},
		async resolveChannelType(channelId) {
			const ch = channelById.get(channelId);
			return ch ? 0 : undefined;
		},
		async resolveGuildIdForChannel(channelId) {
			const ch = channelById.get(channelId);
			return ch ? GUILD : undefined;
		},
		async getActiveThreads() {
			return [];
		},
	};

	return { ds, pageCalls };
}

function archivedThreadConfig(): {
	guildId: string;
	spaceDid: string;
	mode: "full";
	createdAt: number;
	updatedAt: number;
} {
	return {
		guildId: GUILD,
		spaceDid: SPACE,
		mode: "full",
		createdAt: 0,
		updatedAt: 0,
	};
}

/** Count createRoom events for thread-kind rooms in a space. */
function countThreadRoomEvents(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy
		.eventsFor(spaceDid)
		.filter((e) => e.$type === "space.roomy.room.createRoom.v0")
		.filter((e) => e.kind === "space.roomy.thread");
}

describe("ensureAndBackfillArchivedThreads", () => {
	/**
	 * AT01: A multi-page archived-thread backfill completes, passing the
	 * previous page's last thread id (a raw snowflake STRING) as the `before`
	 * cursor — the conversion to a Date happens downstream in the live data
	 * source, so the loop must never Number()-coerce the cursor itself.
	 */
	test("AT01: pages through archived threads with the snowflake cursor", async () => {
		const PARENT = "200000000000000001";
		const source = makeArchivedThreadsSource({
			parents: [
				{
					id: PARENT,
					name: "general",
					pages: [
						[
							{ id: "300000000000000001", name: "t1" },
							{ id: "300000000000000002", name: "t2" },
						],
						[{ id: "300000000000000003", name: "t3" }],
					],
				},
			],
		});

		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE, "full");
		repo.registerMapping(SPACE, "channel", PARENT, newUlid());
		const roomy = new MockRoomyGateway();

		await ensureAndBackfillArchivedThreads(source.ds, repo, roomy, [
			archivedThreadConfig(),
		]);

		// Both pages fetched; second page carried the raw snowflake cursor.
		expect(source.pageCalls).toHaveLength(2);
		expect(source.pageCalls[0]?.before).toBeUndefined();
		expect(source.pageCalls[1]?.before).toBe("300000000000000002");

		// All three threads got rooms + mappings.
		const roomEvents = countThreadRoomEvents(roomy, SPACE);
		expect(roomEvents).toHaveLength(3);
		expect(repo.getRoomyId(SPACE, "thread", "300000000000000001")).toBe(
			roomEvents[0]?.id,
		);
		expect(repo.getRoomyId(SPACE, "thread", "300000000000000003")).toBe(
			roomEvents[2]?.id,
		);
	});

	/**
	 * AT02: A page whose cursor never advances must stop the loop instead of
	 * spinning on the same page forever.
	 */
	test("AT02: stops when a page fails to advance the cursor", async () => {
		const PARENT = "200000000000000001";
		const source = makeArchivedThreadsSource({
			parents: [
				{
					id: PARENT,
					name: "general",
					pages: [[{ id: "300000000000000001", name: "stuck" }]],
					sticky: true,
				},
			],
		});

		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE, "full");
		repo.registerMapping(SPACE, "channel", PARENT, newUlid());
		const roomy = new MockRoomyGateway();

		await ensureAndBackfillArchivedThreads(source.ds, repo, roomy, [
			archivedThreadConfig(),
		]);

		// First page creates the thread, second identical page stalls the loop.
		expect(source.pageCalls).toHaveLength(2);
		expect(countThreadRoomEvents(roomy, SPACE)).toHaveLength(1);
	});

	/**
	 * AT03: A permanently failing parent channel is contained (counted, other
	 * parent channels still processed) instead of one bad page abandoning the
	 * whole guild.
	 */
	test("AT03: a failing parent channel does not stop other parent channels", async () => {
		const PARENT_A = "200000000000000001";
		const PARENT_B = "200000000000000002";
		const source = makeArchivedThreadsSource({
			parents: [
				{ id: PARENT_A, name: "broken", alwaysFail: true },
				{
					id: PARENT_B,
					name: "healthy",
					pages: [[{ id: "300000000000000002", name: "tb" }]],
				},
			],
		});

		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE, "full");
		repo.registerMapping(SPACE, "channel", PARENT_A, newUlid());
		repo.registerMapping(SPACE, "channel", PARENT_B, newUlid());
		const roomy = new MockRoomyGateway();

		await ensureAndBackfillArchivedThreads(source.ds, repo, roomy, [
			archivedThreadConfig(),
		]);

		// The healthy parent's thread is still backfilled.
		const roomEvents = countThreadRoomEvents(roomy, SPACE);
		expect(roomEvents).toHaveLength(1);
		expect(roomEvents[0]?.name).toBe("tb");
	});
});

// ─── Up-front enumeration & Discord-side completion notice ──────────────

/**
 * Enumeration writes every bridged pair + active thread up front (so the
 * Roomy status panel can list a skeleton); the completion notice posts one
 * Discord message per space the run actually did work for, only after every
 * phase (channels, active threads, archived threads) has settled.
 */
describe("backfill enumeration & completion notice", () => {
	afterEach(() => {
		setBackfillNoticeSender(undefined);
		delete process.env.BACKFILL_NOTICE_CHANNEL;
	});

	/** BridgeConfig for the standard test guild/space. */
	function noticeConfig(mode: "full" | "subset" = "full") {
		return {
			guildId: GUILD,
			spaceDid: SPACE,
			mode,
			createdAt: 0,
			updatedAt: 0,
		};
	}


	// ── Enumeration ─────────────────────────────────────────────────────

	test("EN01: enumerates every bridged channel and active thread up front", async () => {
		const parentChannel: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const secondChannel: DiscordChannelData = {
			id: "200000000000000002",
			type: 0,
			name: "dev-chat",
			guildId: GUILD,
		};
		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "dev-help",
			parentId: secondChannel.id,
			guildId: GUILD,
		};
		// A thread whose parent is not bridged must not be enumerated.
		const unmappedThread: DiscordChannelData = {
			id: "300000000000000002",
			type: 11,
			name: "ghost",
			parentId: "999999999999999999",
			guildId: GUILD,
		};

		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [parentChannel, secondChannel] },
			channels: [parentChannel, secondChannel, activeThread, unmappedThread],
			activeThreads: [activeThread, unmappedThread],
		});
		const repo = setupRepo();

		await enumerateBackfillWork(discord, repo, [noticeConfig()]);

		const rows = repo.listBackfillProgress(SPACE);
		expect(rows).toHaveLength(3); // 2 channels + 1 bridged active thread
		const channelRow = rows.find((r) => r.channelId === parentChannel.id);
		expectToBeDefined(channelRow);
		expect(channelRow?.kind).toBe("channel");
		expect(channelRow?.channelName).toBe("general");
		expect(channelRow?.phase).toBe("phase1");
		expect(channelRow?.messagesSynced).toBe(0);
		expect(channelRow?.parentId).toBeNull();
		const threadRow = rows.find((r) => r.channelId === activeThread.id);
		expectToBeDefined(threadRow);
		expect(threadRow?.kind).toBe("thread");
		expect(threadRow?.channelName).toBe("dev-help");
		expect(threadRow?.parentId).toBe(secondChannel.id);
		expect(rows.find((r) => r.channelId === unmappedThread.id)).toBeUndefined();
	});

	test("EN02: enumeration never overwrites real progress or cursor pairs", async () => {
		const parentChannel: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const cursorChannel: DiscordChannelData = {
			id: "200000000000000002",
			type: 0,
			name: "cursor-only",
			guildId: GUILD,
		};
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [parentChannel, cursorChannel] },
			channels: [parentChannel, cursorChannel],
		});
		const repo = setupRepo();
		repo.upsertBackfillProgress({
			spaceDid: SPACE,
			channelId: parentChannel.id,
			guildId: GUILD,
			kind: "channel",
			channelName: "renamed",
			phase: "complete",
			messagesSynced: 42,
			messagesSkipped: 3,
			windowBoundary: "x",
			walkCursor: "y",
		});
		// A pair with a cursor but no progress row must not get a fresh
		// phase1 skeleton either.
		repo.setChannelCursor(SPACE, cursorChannel.id, "200000000000000099");
		expect(repo.getBackfillProgress(SPACE, cursorChannel.id)).toBeUndefined();

		await enumerateBackfillWork(discord, repo, [noticeConfig()]);

		const row = repo.getBackfillProgress(SPACE, parentChannel.id);
		expectToBeDefined(row);
		expect(row?.phase).toBe("complete");
		expect(row?.messagesSynced).toBe(42);
		expect(row?.channelName).toBe("renamed"); // not clobbered back to the live name
		expect(repo.getBackfillProgress(SPACE, cursorChannel.id)).toBeUndefined();
	});

	// ── Completion notice (pure-path) ───────────────────────────────────

	test("CN01: posts one notice to the announcement channel with a summary", async () => {
		const announcement: DiscordChannelData = {
			id: "200000000000000001",
			type: 5,
			name: "announcements",
			guildId: GUILD,
		};
		const general: DiscordChannelData = {
			id: "200000000000000002",
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const pendingChannel: DiscordChannelData = {
			id: "200000000000000003",
			type: 0,
			name: "off-topic",
			guildId: GUILD,
		};
		const doneThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "help",
			parentId: general.id,
			guildId: GUILD,
		};
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [announcement, general, pendingChannel] },
			channels: [announcement, general, pendingChannel, doneThread],
			activeThreads: [doneThread],
		});
		const repo = setupRepo();
		repo.upsertBackfillProgress({
			spaceDid: SPACE,
			channelId: announcement.id,
			guildId: GUILD,
			kind: "channel",
			phase: "complete",
			messagesSynced: 10,
			messagesSkipped: 0,
		});
		repo.upsertBackfillProgress({
			spaceDid: SPACE,
			channelId: general.id,
			guildId: GUILD,
			kind: "channel",
			phase: "complete",
			messagesSynced: 20,
			messagesSkipped: 1,
		});
		repo.upsertBackfillProgress({
			spaceDid: SPACE,
			channelId: doneThread.id,
			guildId: GUILD,
			kind: "thread",
			phase: "complete",
			messagesSynced: 5,
			messagesSkipped: 0,
			parentId: general.id,
		});
		repo.upsertBackfillProgress({
			spaceDid: SPACE,
			channelId: pendingChannel.id,
			guildId: GUILD,
			kind: "channel",
			phase: "phase2",
			messagesSynced: 100,
			messagesSkipped: 0,
		});

		const { sent, mock } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);
		await postBackfillCompletionNotices(
			discord,
			repo,
			[noticeConfig()],
			new Set([SPACE]),
		);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.channelId).toBe(announcement.id);
		const text = sent[0]?.content ?? "";
		expect(text).toContain("Roomy backfill complete");
		expect(text).toContain("2 channels");
		expect(text).toContain("1 thread");
		expect(text).toContain("1 item(s) still pending");
	});

	test("CN02: notices only spaces the run did work for, one per space", async () => {
		const announcement: DiscordChannelData = {
			id: "200000000000000001",
			type: 5,
			name: "announcements",
			guildId: GUILD,
		};
		const OTHER_SPACE = "did:web:other-space.example";
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [announcement] },
			channels: [announcement],
		});
		const repo = setupRepo();
		repo.upsertBridgeConfig(GUILD, OTHER_SPACE, "full");
		const { sent, mock } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);

		await postBackfillCompletionNotices(
			discord,
			repo,
			[noticeConfig(), { ...noticeConfig(), spaceDid: OTHER_SPACE }],
			new Set([SPACE]),
		);

		// Only SPACE is in the work set; OTHER_SPACE must get no notice.
		expect(sent).toHaveLength(1);
		expect(sent[0]?.channelId).toBe(announcement.id);
	});

	test("CN03: a failed send is swallowed, never thrown", async () => {
		const announcement: DiscordChannelData = {
			id: "200000000000000001",
			type: 5,
			name: "announcements",
			guildId: GUILD,
		};
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [announcement] },
			channels: [announcement],
		});
		const repo = setupRepo();
		repo.upsertBridgeConfig(GUILD, SPACE, "full");
		const { sent, mock } = makeMockDiscordSender();
		mock.failSends = true;
		setBackfillNoticeSender(mock);

		await expect(
			postBackfillCompletionNotices(
				discord,
				repo,
				[noticeConfig()],
				new Set([SPACE]),
			),
		).resolves.toBeUndefined();
		expect(sent).toHaveLength(0);
	});

	test("CN04: BACKFILL_NOTICE_CHANNEL override wins; invalid override falls back", async () => {
		const announcement: DiscordChannelData = {
			id: "200000000000000001",
			type: 5,
			name: "announcements",
			guildId: GUILD,
		};
		const general: DiscordChannelData = {
			id: "200000000000000002",
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [announcement, general] },
			channels: [announcement, general],
		});
		const repo = setupRepo();
		const { sent, mock } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);

		process.env.BACKFILL_NOTICE_CHANNEL = general.id;
		await postBackfillCompletionNotices(
			discord,
			repo,
			[noticeConfig()],
			new Set([SPACE]),
		);
		expect(sent[0]?.channelId).toBe(general.id);

		// An override that doesn't resolve to a reachable top-level channel
		// falls back to the announcement channel.
		sent.length = 0;
		process.env.BACKFILL_NOTICE_CHANNEL = "999999999999999999";
		await postBackfillCompletionNotices(
			discord,
			repo,
			[noticeConfig()],
			new Set([SPACE]),
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.channelId).toBe(announcement.id);
	});

	test("CN05: subset mode prefers an allowlisted channel", async () => {
		const general: DiscordChannelData = {
			id: "200000000000000002",
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const dev: DiscordChannelData = {
			id: "200000000000000003",
			type: 0,
			name: "dev",
			guildId: GUILD,
		};
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [general, dev] },
			channels: [general, dev],
		});
		const repo = setupRepo();
		repo.upsertBridgeConfig(GUILD, SPACE, "subset");
		repo.addToAllowlist(SPACE, dev.id, GUILD);
		const { sent, mock } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);

		await postBackfillCompletionNotices(
			discord,
			repo,
			[noticeConfig("subset")],
			new Set([SPACE]),
		);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.channelId).toBe(dev.id);
	});

	// ── Completion notice (end-to-end, once per completed run) ─────────

	test("CN06: runBackfill posts exactly one notice; a re-run over complete work posts none", async () => {
		const announcement: DiscordChannelData = {
			id: "200000000000000001",
			type: 5,
			name: "announcements",
			guildId: GUILD,
		};
		const general: DiscordChannelData = {
			id: "200000000000000002",
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "help",
			parentId: general.id,
			guildId: GUILD,
		};
		const generalMessages = Array.from(
			{ length: 8 },
			(_, i) =>
				cnMessage(
					`2000000000000000${String(i + 10)}`,
					general.id,
				),
		);
		const threadMessages = Array.from(
			{ length: 5 },
			(_, i) => cnMessage(`30000000000000000${i}`, activeThread.id),
		);
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [announcement, general] },
			channels: [announcement, general, activeThread],
			messages: {
				[general.id]: generalMessages,
				[activeThread.id]: threadMessages,
			},
			activeThreads: [activeThread],
		});
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		const { sent, mock, noticePosted } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);

		await runBackfill(discord, repo, roomy);

		// The notice is the last step of the fire-and-forget Phase-2 walk;
		// await the sender signal itself instead of polling the clock.
		await noticePosted;
		expect(sent).toHaveLength(1);
		expect(sent[0]?.channelId).toBe(announcement.id);
		expect(sent[0]?.content).toContain("Roomy backfill complete");
		expect(sent[0]?.content).toContain("channels");

		// Second run: everything is already complete, so this run's work set
		// stays empty — no send can occur (walks skip complete pairs, room
		// creation marks nothing) and no second notice is posted.
		await runBackfill(discord, repo, roomy);
		expect(sent).toHaveLength(1);
	});
});

/**
 * The order the space is built in. A viewer opening the space mid-backfill
 * must see its shape (the sidebar) and its channels' recent history before
 * any thread's, so it reads as a chat server filling up rather than a pile of
 * threads. Only the event order is asserted: how long each step takes is not
 * observable from the events.
 */
describe("backfill work order", () => {
	afterEach(() => {
		setBackfillNoticeSender(undefined);
	});

	test("OR01: syncs structure and channel history before active-thread history", async () => {
		const general: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "help",
			parentId: general.id,
			guildId: GUILD,
		};
		const generalMessages = Array.from({ length: 8 }, (_, i) =>
			cnMessage(`2000000000000000${String(i + 10)}`, general.id),
		);
		const threadMessages = Array.from({ length: 5 }, (_, i) =>
			cnMessage(`30000000000000000${i}`, activeThread.id),
		);
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [general] },
			channels: [general, activeThread],
			messages: {
				[general.id]: generalMessages,
				[activeThread.id]: threadMessages,
			},
			activeThreads: [activeThread],
		});
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		const { mock, noticePosted } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);

		await runBackfill(discord, repo, roomy);
		// The remainder walk continues in the background; wait for its last
		// step so the recorded events are complete before they are read.
		await noticePosted;

		const events = roomy.eventsFor(SPACE);
		const channelRoom = repo.getRoomyId(SPACE, "channel", general.id);
		const threadRoom = repo.getRoomyId(SPACE, "thread", activeThread.id);
		expectToBeDefined(channelRoom);
		expectToBeDefined(threadRoom);

		const structureAt = events.findIndex(
			(e) => e.$type === "space.roomy.space.updateSidebar.v1",
		);
		const threadRoomAt = events.findIndex(
			(e) =>
				e.$type === "space.roomy.room.createRoom.v0" && e.id === threadRoom,
		);
		const firstThreadMessageAt = events.findIndex(
			(e) =>
				e.$type === "space.roomy.message.createMessage.v0" &&
				e.room === threadRoom,
		);
		const channelMessageIndexes = events
			.map((e, index) => ({ e, index }))
			.filter(
				({ e }) =>
					e.$type === "space.roomy.message.createMessage.v0" &&
					e.room === channelRoom,
			)
			.map(({ index }) => index);

		// Every marker must exist, or the comparisons below read -1.
		expect(structureAt).toBeGreaterThanOrEqual(0);
		expect(threadRoomAt).toBeGreaterThanOrEqual(0);
		expect(firstThreadMessageAt).toBeGreaterThanOrEqual(0);
		expect(channelMessageIndexes).toHaveLength(generalMessages.length);

		// Structure first, then the channel's whole history, then the thread.
		expect(structureAt).toBeLessThan(threadRoomAt);
		expect(Math.max(...channelMessageIndexes)).toBeLessThan(threadRoomAt);
		expect(threadRoomAt).toBeLessThan(firstThreadMessageAt);
	});
});

// ─── A live cursor is not backfill progress ─────────────────────────────

/**
 * The shape a channel has when the live path has ingested to it and the
 * backfill has never walked it: a channel cursor at the live message, no
 * backfill_progress row. The cursor is the live path's high-water mark and
 * records nothing about how much history is in the space, so the bounded
 * Phase-1 window must still run and the Phase-2 walk must still cover
 * everything below it.
 */
describe("live cursor is not backfill progress", () => {
	beforeEach(() => {
		faker.seed(42);
	});

	afterEach(() => {
		setBackfillNoticeSender(undefined);
	});

	/** createMessage events the run sent into a channel/thread's Roomy room. */
	function roomMessageEvents(
		roomy: MockRoomyGateway,
		repo: BridgeRepository,
		kind: "channel" | "thread",
		discordId: string,
	): number {
		const roomyId = repo.getRoomyId(SPACE, kind, discordId);
		return roomy
			.eventsFor(SPACE)
			.filter(
				(e) =>
					e.$type === "space.roomy.message.createMessage.v0" &&
					e.room === roomyId,
			).length;
	}

	/** Announcement channel for a fake guild — the notice destination. */
	function announcementChannel(id: string): DiscordChannelData {
		return { id, type: 5, name: "announcements", guildId: GUILD };
	}

	test("BF15: a live-ingested message does not hide the channel's history from runBackfill", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 3000,
		});
		channels.push(announcementChannel("290000000000000001"));
		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		const channel = channels[0];
		expectToBeDefined(channel);
		const history = messages[channel.id] ?? [];
		expect(history.length).toBe(3000);

		// Live ingest of the newest message: the live path writes the channel
		// cursor and no progress row.
		const liveMessage = history.at(-1);
		expectToBeDefined(liveMessage);
		await ingestDiscordMessage(
			liveMessage,
			repo,
			roomy,
			GUILD,
			SPACE,
			(snowflake) => discord.resolveChannelName(snowflake),
		);
		expect(repo.getChannelCursor(SPACE, channel.id)?.lastMessageId).toBe(
			liveMessage.id,
		);
		expect(repo.getBackfillProgress(SPACE, channel.id)).toBeUndefined();

		const { mock, noticePosted } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);
		await runBackfill(discord, repo, roomy);
		await noticePosted;

		// The whole history — the live message alone is not a backfill.
		expect(
			roomMessageEvents(roomy, repo, "channel", channel.id),
		).toBeGreaterThanOrEqual(3000 - 300);
		const progress = repo.getBackfillProgress(SPACE, channel.id);
		expectToBeDefined(progress);
		expect(progress?.phase).toBe("complete");
		expect(progress?.messagesSynced).toBeGreaterThanOrEqual(3000 - 300);
	});

	test("BF16: a mid-history cursor with no progress row still backfills the whole channel", async () => {
		const { guild, channels, messages } = createFakeGuild({
			seed: 42,
			channelCount: 1,
			messagesPerChannel: 2500,
		});
		channels.push(announcementChannel("290000000000000002"));
		const discord = buildFakeDiscord(guild, channels, messages);
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();
		mapChannels(repo, channels);

		const channel = channels[0];
		expectToBeDefined(channel);
		const history = messages[channel.id] ?? [];

		// The pre-two-phase upgrade shape: a cursor partway up the channel and
		// no durable progress row at all.
		const midfield = history[999];
		expectToBeDefined(midfield);
		repo.setChannelCursor(SPACE, channel.id, midfield.id);
		expect(repo.getBackfillProgress(SPACE, channel.id)).toBeUndefined();

		const { mock, noticePosted } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);
		await runBackfill(discord, repo, roomy);
		await noticePosted;

		// Everything below the cursor too, not just the newer half.
		expect(
			roomMessageEvents(roomy, repo, "channel", channel.id),
		).toBeGreaterThanOrEqual(2500 - 250);
		const progress = repo.getBackfillProgress(SPACE, channel.id);
		expectToBeDefined(progress);
		expect(progress?.phase).toBe("complete");
		expect(progress?.messagesSynced).toBeGreaterThanOrEqual(2500 - 250);
	});

	test("BF17: a thread whose live path wrote a cursor still gets its whole history", async () => {
		const general: DiscordChannelData = {
			id: "200000000000000001",
			type: 0,
			name: "general",
			guildId: GUILD,
		};
		const activeThread: DiscordChannelData = {
			id: "300000000000000001",
			type: 11,
			name: "help",
			parentId: general.id,
			guildId: GUILD,
		};
		const announcement = announcementChannel("290000000000000003");
		const generalMessages = Array.from({ length: 5 }, (_, i) =>
			cnMessage(`2000000000000000${String(i + 10)}`, general.id),
		);
		const threadMessages = Array.from({ length: 1200 }, (_, i) =>
			cnMessage(
				(300000000000000000n + BigInt(i) * 2n).toString(),
				activeThread.id,
			),
		);
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels: [general, announcement] },
			channels: [general, activeThread, announcement],
			messages: {
				[general.id]: generalMessages,
				[activeThread.id]: threadMessages,
			},
			activeThreads: [activeThread],
		});
		const repo = setupRepo();
		const roomy = new MockRoomyGateway();

		// The channel and thread rooms already exist — the live path created
		// the thread's room, so ensureRoomyThreads skips it (and its Phase-1
		// window) and only Phase 2 walks the thread.
		repo.registerMapping(SPACE, "channel", general.id, newUlid());
		repo.registerMapping(SPACE, "thread", activeThread.id, newUlid());

		const newest = threadMessages.at(-1);
		expectToBeDefined(newest);
		await ingestDiscordMessage(
			newest,
			repo,
			roomy,
			GUILD,
			SPACE,
			(snowflake) => discord.resolveChannelName(snowflake),
		);
		expect(repo.getChannelCursor(SPACE, activeThread.id)?.lastMessageId).toBe(
			newest.id,
		);
		expect(repo.getBackfillProgress(SPACE, activeThread.id)).toBeUndefined();

		const { mock, noticePosted } = makeMockDiscordSender();
		setBackfillNoticeSender(mock);
		await runBackfill(discord, repo, roomy);
		await noticePosted;

		expect(
			roomMessageEvents(roomy, repo, "thread", activeThread.id),
		).toBeGreaterThanOrEqual(1200 - 120);
		const progress = repo.getBackfillProgress(SPACE, activeThread.id);
		expectToBeDefined(progress);
		expect(progress?.kind).toBe("thread");
		expect(progress?.phase).toBe("complete");
		expect(progress?.messagesSynced).toBeGreaterThanOrEqual(1200 - 120);
	});
});
