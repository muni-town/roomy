/**
 * Unit tests for room-sync.ts
 *
 * Covers: RO01–RO13 — channel/thread create, update, delete,
 * full/subset mode, public/private, fan-out, idempotency.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Event, newUlid, Ulid } from "@roomy-space/sdk";
import type { BridgeConfig } from "../../db/repository.ts";
import { BridgeRepository } from "../../db/repository.ts";
import { FileDiscordDataSource } from "../../discord/file-data-source.ts";
import { resetCapacityGate, setCapacityGate } from "../../roomy/capacity.ts";
import type { RoomyGateway } from "../../roomy/gateway.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import {
	ensureRoomyChannel,
	handleChannelCreate,
	handleRoomDelete,
	handleRoomUpdate,
	handleThreadCreate,
	mergeGuildStructure,
	readGuildStructure,
	syncInitialStructure,
} from "../room-sync.ts";
import {
	CATEGORY,
	CATEGORY_2,
	CHANNEL,
	CHANNEL_2,
	CHANNEL_3,
	GUILD,
	makeCategory,
	makeChannel,
	makeThread,
	ROOMY_CHANNEL_ULID,
	SPACE_A,
	SPACE_B,
	THREAD,
} from "./helpers/test-data.ts";
import { expectToBe } from "./utils.ts";

function createRoomEvent(gateway: MockRoomyGateway, spaceDid: string) {
	return gateway.findEvent(spaceDid, "space.roomy.room.createRoom.v0");
}

/** Extract specific event types from sendEvents calls (used for threads). */
function eventsFromGateway(
	gateway: MockRoomyGateway,
	spaceDid: string,
	$type: string,
) {
	return gateway.eventsFor(spaceDid).filter((e) => e.$type === $type);
}

function setupRepo(mode: "full" | "subset" = "full"): BridgeRepository {
	const repo = BridgeRepository.open(":memory:");
	repo.upsertBridgeConfig(GUILD, SPACE_A, mode);
	return repo;
}

describe("handleChannelCreate", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// RO01: Channel create (full mode)
	test("RO01: creates room for new channel in full mode", async () => {
		const channel = makeChannel();

		await handleChannelCreate(channel, repo, roomy);

		const event = createRoomEvent(roomy, SPACE_A);
		expect(event).toBeDefined();
		expectToBe(event?.$type, "space.roomy.room.createRoom.v0");
		expect(event?.kind).toBe("space.roomy.channel");
		expect(event?.name).toBe("general");
		expect(event?.defaultAccess).toBe("read");

		// Mapping registered
		expect(repo.getRoomyId(SPACE_A, "channel", CHANNEL)).toBe(event?.id);

		// Discord origin extension
		const origin =
			event?.extensions?.["space.roomy.extension.discordOrigin.v0"];
		expect(origin?.snowflake).toBe(CHANNEL);
		expect(origin?.guildId).toBe(GUILD);
	});

	// RO02: Channel create (subset mode, allowlisted)
	test("RO02: creates room for allowlisted channel in subset mode", async () => {
		repo = setupRepo("subset");
		repo.addToAllowlist(SPACE_A, CHANNEL, GUILD);
		roomy = new MockRoomyGateway();

		const channel = makeChannel();
		await handleChannelCreate(channel, repo, roomy);

		const event = createRoomEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.room.createRoom.v0");
		expect(event?.name).toBe("general");
	});

	// RO03: Channel create (subset mode, NOT allowlisted)
	test("RO03: skips channel not in subset allowlist", async () => {
		repo = setupRepo("subset");
		roomy = new MockRoomyGateway();

		const channel = makeChannel();
		await handleChannelCreate(channel, repo, roomy);

		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// RO04: Private channel → defaultAccess = "none"
	test("RO04: sets defaultAccess=none for private channel", async () => {
		const channel = makeChannel({
			permissionOverwrites: [{ id: GUILD, deny: ["VIEW_CHANNEL"] }],
		});

		await handleChannelCreate(channel, repo, roomy);

		const event = createRoomEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.room.createRoom.v0");
		expect(event?.defaultAccess).toBe("none");
	});

	// RO05: Public channel → defaultAccess = "read"
	test("RO05: sets defaultAccess=read for public channel", async () => {
		const channel = makeChannel({
			permissionOverwrites: [{ id: GUILD, deny: [] }],
		});

		await handleChannelCreate(channel, repo, roomy);

		const event = createRoomEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.room.createRoom.v0");
		expect(event?.defaultAccess).toBe("read");
	});

	// RO13: Channel create fan-out
	test("RO13: fans out channel creation to multiple spaces", async () => {
		repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
		roomy = new MockRoomyGateway();

		const channel = makeChannel();
		await handleChannelCreate(channel, repo, roomy);

		expect(createRoomEvent(roomy, SPACE_A)).toBeDefined();
		expect(createRoomEvent(roomy, SPACE_B)).toBeDefined();
	});

	test("skips when channel has no guildId", async () => {
		const channel = makeChannel({ guildId: undefined });
		await handleChannelCreate(channel, repo, roomy);
		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
	});

	test("skips thread types dispatched as CHANNEL_CREATE", async () => {
		const channel = makeChannel({ type: 11 }); // PublicThread
		await handleChannelCreate(channel, repo, roomy);
		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
	});

	test("skips when channel has no name", async () => {
		const channel = makeChannel({ name: undefined });
		await handleChannelCreate(channel, repo, roomy);
		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
	});
});

describe("handleThreadCreate", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		// Pre-map the parent channel
		repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
	});

	// RO06: Thread create with parent bridged
	test("RO06: creates room + room link for thread under bridged parent", async () => {
		const thread = makeThread({ parentId: CHANNEL });

		await handleThreadCreate(thread, repo, roomy);

		const roomEvents = eventsFromGateway(
			roomy,
			SPACE_A,
			"space.roomy.room.createRoom.v0",
		);
		const linkEvents = eventsFromGateway(
			roomy,
			SPACE_A,
			"space.roomy.link.createRoomLink.v0",
		);

		expect(roomEvents).toHaveLength(1);
		expectToBe(roomEvents[0]?.$type, "space.roomy.room.createRoom.v0");
		expectToBe(roomEvents[0]?.kind, "space.roomy.thread");
		expectToBe(roomEvents[0]?.name, "my-thread");

		expect(linkEvents).toHaveLength(1);
		expectToBe(linkEvents[0]?.$type, "space.roomy.link.createRoomLink.v0");
		expect(linkEvents[0]?.linkToRoom).toBe(roomEvents[0].id);
		expect(linkEvents[0]?.isCreationLink).toBe(true);

		// Mapping registered
		expect(repo.getRoomyId(SPACE_A, "thread", THREAD)).toBe(roomEvents[0].id);
	});

	// RO07: Thread create without parent bridged
	test("RO07: skips thread when parent channel not bridged", async () => {
		const thread = makeThread({
			parentId: "999999999999999999", // not bridged
		});

		await handleThreadCreate(thread, repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});

	// RO08: Private thread synced with defaultAccess=none
	test("RO08: syncs private threads with defaultAccess=none", async () => {
		const thread = makeThread({
			type: 12, // PRIVATE_THREAD
			parentId: CHANNEL,
		});

		await handleThreadCreate(thread, repo, roomy);

		const roomEvent = createRoomEvent(roomy, SPACE_A);
		expect(roomEvent).toBeDefined();
		expect(roomEvent?.defaultAccess).toBe("none");
		expect(roomEvent?.kind).toBe("space.roomy.thread");

		// Mapping should be registered
		expect(repo.getRoomyId(SPACE_A, "thread", THREAD)).toBe(roomEvent?.id);
	});

	// RO09: Thread create with existing mapping (idempotent)
	test("RO09: skips thread creation when mapping already exists", async () => {
		repo.registerMapping(SPACE_A, "thread", THREAD, "existing-ulid");

		const thread = makeThread({ parentId: CHANNEL });
		await handleThreadCreate(thread, repo, roomy);

		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});

	test("skips thread without parentId or guildId", async () => {
		const noParent = makeThread({ parentId: undefined });
		await handleThreadCreate(noParent, repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);

		roomy.reset();
		const noGuild = makeThread({ guildId: undefined });
		await handleThreadCreate(noGuild, repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});

	// RO11: Thread created by the bridge bot (echo prevention).
	// When the bridge mirrors a Roomy thread to Discord, the bot creates the
	// thread and Discord sets owner_id to the bot. The gateway THREAD_CREATE
	// event for that thread must not be re-created on Roomy, even if the
	// thread→Roomy mapping hasn't been registered yet (REST/gateway race).
	test("RO11: skips thread created by the bridge bot (echo prevention)", async () => {
		const thread = makeThread({
			parentId: CHANNEL,
			ownerId: "999999999999999999",
		});

		await handleThreadCreate(thread, repo, roomy, "999999999999999999");

		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});

	// RO12: A thread owned by a different user is still bridged.
	test("RO12: bridges thread owned by another user", async () => {
		const thread = makeThread({
			parentId: CHANNEL,
			ownerId: "888888888888888888",
		});

		await handleThreadCreate(thread, repo, roomy, "999999999999999999");

		expect(roomy.eventCount(SPACE_A)).toBeGreaterThan(0);
	});
});

describe("handleRoomUpdate", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
	});

	// RO10: Channel/thread update (rename)
	test("RO10: sends updateRoom for renamed channel", async () => {
		const channel = makeChannel({ name: "new-name" });

		await handleRoomUpdate(channel, repo, roomy);

		const event = roomy.eventsFor(SPACE_A)[0];
		expectToBe(event?.$type, "space.roomy.room.updateRoom.v0");
		expect(event.roomId).toBe(ROOMY_CHANNEL_ULID);
		expect(event.name).toBe("new-name");
	});

	test("skips update for unmapped channel", async () => {
		const channel = makeChannel({ id: "999999999999999999" });
		await handleRoomUpdate(channel, repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});

	test("skips update when channel has no name", async () => {
		const channel = makeChannel({ name: undefined });
		await handleRoomUpdate(channel, repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});

	test("skips update when guildId missing", async () => {
		const channel = makeChannel({ guildId: undefined });
		await handleRoomUpdate(channel, repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});
});

describe("handleRoomDelete", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
	});

	// RO11: Channel/thread delete
	test("RO11: sends deleteRoom and unregisters mapping", async () => {
		const channel = makeChannel();

		await handleRoomDelete(channel, repo, roomy);

		const event = roomy.eventsFor(SPACE_A)[0];
		expectToBe(event?.$type, "space.roomy.room.deleteRoom.v0");
		expect(event.roomId).toBe(ROOMY_CHANNEL_ULID);

		// Mapping removed
		expect(repo.getRoomyId(SPACE_A, "channel", CHANNEL)).toBeUndefined();
	});

	// RO12: Delete on unmapped room skipped
	test("RO12: skips delete for unmapped channel", async () => {
		const channel = makeChannel({ id: "999999999999999999" });
		await handleRoomDelete(channel, repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});

	test("skips delete when no guildId", async () => {
		const channel = makeChannel({ guildId: undefined });
		await handleRoomDelete(channel, repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});
});

describe("ensureRoomyChannel", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	test("creates room for a channel in target spaces", async () => {
		await ensureRoomyChannel(repo, roomy, CHANNEL, GUILD, "general", [SPACE_A]);

		const event = createRoomEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.room.createRoom.v0");
		expect(event?.name).toBe("general");
		expect(event?.defaultAccess).toBe("read");
		expect(repo.getRoomyId(SPACE_A, "channel", CHANNEL)).toBe(event?.id);
	});

	test("skips channel already synced to a space", async () => {
		repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);

		await ensureRoomyChannel(repo, roomy, CHANNEL, GUILD, "general", [SPACE_A]);

		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
	});

	test("respects defaultAccess override", async () => {
		await ensureRoomyChannel(
			repo,
			roomy,
			CHANNEL,
			GUILD,
			"private-channel",
			[SPACE_A],
			"none",
		);

		const event = createRoomEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.room.createRoom.v0");
		expect(event?.defaultAccess).toBe("none");
	});
});

describe("room-sync — capacity enforcement", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		setCapacityGate({ isEnabled: async () => false });
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	afterEach(() => {
		resetCapacityGate();
	});

	test("CAP01: handleChannelCreate creates no room when over capacity", async () => {
		await handleChannelCreate(makeChannel(), repo, roomy);

		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
		expect(repo.getRoomyId(SPACE_A, "channel", CHANNEL)).toBeUndefined();
	});

	test("CAP02: handleThreadCreate creates no room when over capacity", async () => {
		await handleThreadCreate(makeThread(), repo, roomy);

		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
	});

	test("CAP03: ensureRoomyChannel creates no room when over capacity", async () => {
		await ensureRoomyChannel(repo, roomy, CHANNEL, GUILD, "general", [SPACE_A]);

		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
	});
});

// ─── Initial structure sync (one-shot) ──────────────────────────────────

/** The bridge config the structure tests operate on. */
const fullConfig: BridgeConfig[] = [
	{
		guildId: GUILD,
		spaceDid: SPACE_A,
		mode: "full",
		createdAt: 0,
		updatedAt: 0,
	},
];
const subsetConfig: BridgeConfig[] = [
	{
		guildId: GUILD,
		spaceDid: SPACE_A,
		mode: "subset",
		createdAt: 0,
		updatedAt: 0,
	},
];

/** A guild with two categories and three channels, in Discord order. */
function makeGuild() {
	const channels = [
		makeCategory({ id: CATEGORY, name: "announcements", position: 0 }),
		makeChannel({
			id: CHANNEL_3,
			name: "rules",
			parentId: CATEGORY,
			position: 1,
		}),
		makeCategory({ id: CATEGORY_2, name: "chat", position: 2 }),
		makeChannel({
			id: CHANNEL_2,
			name: "off-topic",
			parentId: CATEGORY_2,
			position: 4,
		}),
		makeChannel({
			id: CHANNEL,
			name: "general",
			parentId: CATEGORY_2,
			position: 3,
		}),
	];
	return FileDiscordDataSource.fromData({
		guild: { id: GUILD, channels },
		channels,
		messages: {},
	});
}

/** Map three bridged channels to rooms, the way ensureRoomyRooms would. */
function mapBridgedChannels(repo: BridgeRepository) {
	const ids = new Map<string, Ulid>();
	for (const channelId of [CHANNEL, CHANNEL_2, CHANNEL_3]) {
		const roomyId = newUlid();
		repo.registerMapping(SPACE_A, "channel", channelId, roomyId);
		ids.set(channelId, roomyId);
	}
	return ids;
}

/**
 * Fixed ids for the "space already has a sidebar" fixtures. Roomy category
 * ids and child room ids cross the same `Ulid`-branded boundary the real
 * sidebar does, so they are branded here rather than at each use.
 */
const EXISTING_CATEGORY_ID = Ulid.assert("01CCCCCCCCCCCCCCCCCCCCCCCC");
const EXISTING_CHILD_ID = Ulid.assert("01DDDDDDDDDDDDDDDDDDDDDDDD");

/** The Roomy room mapped to a Discord channel, asserting the mapping exists. */
function roomOf(rooms: Map<string, Ulid>, channelId: string): Ulid {
	const roomId = rooms.get(channelId);
	if (roomId === undefined) {
		throw new Error(`No Roomy room mapped for test channel ${channelId}`);
	}
	return roomId;
}

describe("mergeGuildStructure", () => {
	test("orders a category's children by Discord position", () => {
		const structure = {
			categories: [{ id: CATEGORY_2, name: "chat", position: 2 }],
			channels: [
				makeChannel({ id: CHANNEL_2, parentId: CATEGORY_2, position: 4 }),
				makeChannel({ id: CHANNEL, parentId: CATEGORY_2, position: 3 }),
			],
		};
		const rooms = new Map([
			[CHANNEL, "01AAAAAAAAAAAAAAAAAAAAAAAA"],
			[CHANNEL_2, "01BBBBBBBBBBBBBBBBBBBBBBBB"],
		]);

		const merged = mergeGuildStructure([], structure, rooms);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.name).toBe("chat");
		// general is position 3, off-topic is position 4 — Discord order, not
		// the order the channels arrived in.
		expect(merged[0]?.children).toEqual([
			"01AAAAAAAAAAAAAAAAAAAAAAAA",
			"01BBBBBBBBBBBBBBBBBBBBBBBB",
		]);
	});

	test("orders categories by Discord position", () => {
		const structure = {
			categories: [
				{ id: CATEGORY, name: "announcements", position: 0 },
				{ id: CATEGORY_2, name: "chat", position: 2 },
			],
			channels: [
				makeChannel({ id: CHANNEL_3, parentId: CATEGORY, position: 1 }),
				makeChannel({ id: CHANNEL, parentId: CATEGORY_2, position: 3 }),
			],
		};
		const rooms = new Map([
			[CHANNEL_3, "01AAAAAAAAAAAAAAAAAAAAAAAA"],
			[CHANNEL, "01BBBBBBBBBBBBBBBBBBBBBBBB"],
		]);

		const merged = mergeGuildStructure([], structure, rooms);

		expect(merged.map((c) => c.name)).toEqual(["announcements", "chat"]);
	});

	test("preserves existing categories and their children", () => {
		const structure = {
			categories: [{ id: CATEGORY, name: "announcements", position: 0 }],
			channels: [
				makeChannel({ id: CHANNEL_3, parentId: CATEGORY, position: 1 }),
			],
		};
		const existing = [
			{
				id: EXISTING_CATEGORY_ID,
				name: "roomy-native",
				children: [EXISTING_CHILD_ID],
			},
		];

		const merged = mergeGuildStructure(
			existing,
			structure,
			new Map([[CHANNEL_3, "01AAAAAAAAAAAAAAAAAAAAAAAA"]]),
		);

		expect(merged).toHaveLength(2);
		expect(merged[0]).toEqual(existing[0]);
		expect(merged[1]?.name).toBe("announcements");
		expect(merged[1]?.children).toEqual(["01AAAAAAAAAAAAAAAAAAAAAAAA"]);
	});

	test("merges a Discord category into an existing one of the same name", () => {
		const structure = {
			categories: [{ id: CATEGORY, name: "general", position: 0 }],
			channels: [
				makeChannel({ id: CHANNEL_3, parentId: CATEGORY, position: 1 }),
			],
		};
		const existing = [
			{
				id: EXISTING_CATEGORY_ID,
				name: "general",
				children: [EXISTING_CHILD_ID],
			},
		];

		const merged = mergeGuildStructure(
			existing,
			structure,
			new Map([[CHANNEL_3, "01AAAAAAAAAAAAAAAAAAAAAAAA"]]),
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.id).toBe(EXISTING_CATEGORY_ID);
		// The existing child is kept; the Discord channel is appended.
		expect(merged[0]?.children).toEqual([
			EXISTING_CHILD_ID,
			"01AAAAAAAAAAAAAAAAAAAAAAAA",
		]);
	});

	test("skips categories whose channels are all unbridged", () => {
		const structure = {
			categories: [
				{ id: CATEGORY, name: "empty", position: 0 },
				{ id: CATEGORY_2, name: "chat", position: 1 },
			],
			channels: [
				makeChannel({ id: CHANNEL_2, parentId: CATEGORY }),
				makeChannel({ id: CHANNEL, parentId: CATEGORY_2 }),
			],
		};

		const merged = mergeGuildStructure(
			[],
			structure,
			new Map([[CHANNEL, "01AAAAAAAAAAAAAAAAAAAAAAAA"]]),
		);

		expect(merged.map((c) => c.name)).toEqual(["chat"]);
	});

	test("places uncategorized channels in the first category", () => {
		const structure = {
			categories: [{ id: CATEGORY, name: "chat", position: 0 }],
			channels: [
				makeChannel({ id: CHANNEL, parentId: CATEGORY, position: 0 }),
				makeChannel({ id: CHANNEL_2, parentId: undefined, position: 1 }),
			],
		};

		const merged = mergeGuildStructure(
			[],
			structure,
			new Map([
				[CHANNEL, "01AAAAAAAAAAAAAAAAAAAAAAAA"],
				[CHANNEL_2, "01BBBBBBBBBBBBBBBBBBBBBBBB"],
			]),
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.children).toEqual([
			"01AAAAAAAAAAAAAAAAAAAAAAAA",
			"01BBBBBBBBBBBBBBBBBBBBBBBB",
		]);
	});

	test("keeps a channel whose category is missing from the payload", () => {
		// parentId points at a category absent from the payload — the room
		// must still appear, not vanish from the sidebar.
		const structure = {
			categories: [],
			channels: [makeChannel({ id: CHANNEL, parentId: "999999999999999999" })],
		};

		const merged = mergeGuildStructure(
			[],
			structure,
			new Map([[CHANNEL, "01AAAAAAAAAAAAAAAAAAAAAAAA"]]),
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.children).toEqual(["01AAAAAAAAAAAAAAAAAAAAAAAA"]);
	});

	test("matches a differently-cased Discord category instead of duplicating it", () => {
		// Production shape: the space is seeded with lower-case `general`
		// (`sdk/src/operations/space.ts`) while the guild reports `General`.
		// A verbatim match forged a second header with the same room under
		// both. The room must appear exactly once, in the seeded category.
		const existing = [
			{
				id: EXISTING_CATEGORY_ID,
				name: "general",
				children: [EXISTING_CHILD_ID],
			},
			{ name: "dev", children: [] },
		];
		const structure = {
			categories: [
				{ id: CATEGORY, name: "General", position: 0 },
				{ id: CATEGORY_2, name: "dev", position: 1 },
			],
			channels: [
				makeChannel({ id: CHANNEL, parentId: CATEGORY, position: 0 }),
				makeChannel({ id: CHANNEL_2, parentId: CATEGORY_2, position: 1 }),
			],
		};
		const rooms = new Map([
			[CHANNEL, "01AAAAAAAAAAAAAAAAAAAAAAAA"],
			[CHANNEL_2, "01BBBBBBBBBBBBBBBBBBBBBBBB"],
		]);

		const merged = mergeGuildStructure(existing, structure, rooms);

		// No second `General` header: the guild's category merged into the
		// seeded one, which received the room.
		expect(merged.map((c) => c.name)).toEqual(["general", "dev"]);
		expect(merged).toHaveLength(2);
		expect(merged[0]?.children).toEqual([
			EXISTING_CHILD_ID,
			"01AAAAAAAAAAAAAAAAAAAAAAAA",
		]);
		expect(merged[1]?.children).toEqual(["01BBBBBBBBBBBBBBBBBBBBBBBB"]);
		expect(
			merged.filter((c) => c.children.includes("01AAAAAAAAAAAAAAAAAAAAAAAA")),
		).toHaveLength(1);
	});

	test("does not re-place a room already under a category the guild does not share", () => {
		// An admin moved a bridged room under a category of their own; the
		// guild still reports the channel under a different, exact-name
		// category. No case mismatch involved — the per-category guard alone
		// misses this and appends the room a second time.
		const existing = [
			{
				id: EXISTING_CATEGORY_ID,
				name: "general",
				children: [EXISTING_CHILD_ID],
			},
			{ name: "dev", children: [] },
		];
		const structure = {
			categories: [
				{ id: CATEGORY, name: "general", position: 0 },
				{ id: CATEGORY_2, name: "dev", position: 1 },
			],
			channels: [
				makeChannel({ id: CHANNEL, parentId: CATEGORY, position: 0 }),
				makeChannel({ id: CHANNEL_2, parentId: CATEGORY_2, position: 1 }),
				makeChannel({ id: CHANNEL_3, parentId: CATEGORY_2, position: 2 }),
			],
		};
		const rooms = new Map([
			[CHANNEL, "01AAAAAAAAAAAAAAAAAAAAAAAA"],
			[CHANNEL_2, "01BBBBBBBBBBBBBBBBBBBBBBBB"],
			[CHANNEL_3, EXISTING_CHILD_ID],
		]);

		const merged = mergeGuildStructure(existing, structure, rooms);

		// The pre-placed room stays under `general` only; the guild's `dev`
		// did not receive a copy.
		expect(merged[0]?.children).toEqual([
			EXISTING_CHILD_ID,
			"01AAAAAAAAAAAAAAAAAAAAAAAA",
		]);
		expect(merged[1]?.children).toEqual(["01BBBBBBBBBBBBBBBBBBBBBBBB"]);
		expect(
			merged.filter((c) => c.children.includes(EXISTING_CHILD_ID)),
		).toHaveLength(1);
	});

	test("exact-case same-name merge stays a no-op for an already-placed room", () => {
		// The room is already the only child of the matching category — the
		// merge must neither duplicate the room nor add a second category.
		const existing = [
			{
				id: EXISTING_CATEGORY_ID,
				name: "general",
				children: ["01AAAAAAAAAAAAAAAAAAAAAAAA"],
			},
		];
		const structure = {
			categories: [{ id: CATEGORY, name: "general", position: 0 }],
			channels: [makeChannel({ id: CHANNEL, parentId: CATEGORY, position: 0 })],
		};

		const merged = mergeGuildStructure(
			existing,
			structure,
			new Map([[CHANNEL, "01AAAAAAAAAAAAAAAAAAAAAAAA"]]),
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]?.name).toBe("general");
		expect(merged[0]?.children).toEqual(["01AAAAAAAAAAAAAAAAAAAAAAAA"]);
	});
});

describe("syncInitialStructure", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	function sidebarEvents() {
		return eventsFromGateway(
			roomy,
			SPACE_A,
			"space.roomy.space.updateSidebar.v1",
		).filter(
			(
				e,
			): e is Extract<Event, { $type: "space.roomy.space.updateSidebar.v1" }> =>
				e.$type === "space.roomy.space.updateSidebar.v1",
		);
	}

	test("ST01: writes categories and channel order derived from Discord position", async () => {
		const rooms = mapBridgedChannels(repo);

		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);

		const events = sidebarEvents();
		expect(events).toHaveLength(1);
		const categories = events[0]?.categories;
		expect(categories?.map((c) => c.name)).toEqual(["announcements", "chat"]);
		// announcements holds rules; chat holds general (position 3) before
		// off-topic (position 4).
		expect(categories?.[0]?.children).toEqual([roomOf(rooms, CHANNEL_3)]);
		expect(categories?.[1]?.children).toEqual([
			roomOf(rooms, CHANNEL),
			roomOf(rooms, CHANNEL_2),
		]);
	});

	test("ST02: a category type is never bridged as a room", async () => {
		mapBridgedChannels(repo);

		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);

		expect(createRoomEvent(roomy, SPACE_A)).toBeUndefined();
		expect(repo.getRoomyId(SPACE_A, "channel", CATEGORY)).toBeUndefined();
	});

	test("ST03: a second call does not re-apply the structure", async () => {
		mapBridgedChannels(repo);
		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);
		expect(sidebarEvents()).toHaveLength(1);

		// The guard is the only thing preventing a second write, so this is
		// the assertion that fails when `claimStructureSync` is removed.
		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);
		expect(sidebarEvents()).toHaveLength(1);
	});

	test("ST04: a later Discord channel event does not re-order or re-apply", async () => {
		mapBridgedChannels(repo);
		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);
		const before = sidebarEvents()[0]?.categories;
		expect(before).toHaveLength(2);

		// Ongoing Discord traffic, exactly as the gateway delivers it: a new
		// channel and a reorder-triggering update. Neither path calls the
		// structure sync, so the sidebar is untouched.
		await handleChannelCreate(
			makeChannel({ id: "823456789012345678", name: "new-channel" }),
			repo,
			roomy,
		);
		await handleRoomUpdate(
			makeChannel({ id: CHANNEL, name: "general-renamed" }),
			repo,
			roomy,
		);

		expect(sidebarEvents()).toHaveLength(1);
		expect(sidebarEvents()[0]?.categories).toEqual(before);
	});

	test("ST05: is idempotent across backfill runs via the persisted marker", async () => {
		mapBridgedChannels(repo);

		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);

		// A reconnect re-runs the backfill; the claim is in the repo, so a
		// fresh call on the same repo (same process, or after a restart from
		// the same DB) must not write again.
		expect(repo.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(true);

		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);

		expect(sidebarEvents()).toHaveLength(1);
	});

	test("ST06: merges into the space's existing sidebar", async () => {
		const rooms = mapBridgedChannels(repo);
		roomy.setSidebar(SPACE_A, [
			{
				id: EXISTING_CATEGORY_ID,
				name: "chat",
				children: [EXISTING_CHILD_ID],
			},
		]);

		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);

		const categories = sidebarEvents()[0]?.categories;
		// The existing category keeps its position and id, and its existing
		// child stays ahead of the Discord channels appended to it.
		expect(categories?.[0]?.id).toBe(EXISTING_CATEGORY_ID);
		expect(categories?.[0]?.children).toEqual([
			EXISTING_CHILD_ID,
			roomOf(rooms, CHANNEL),
			roomOf(rooms, CHANNEL_2),
		]);
		// A Discord category with no existing counterpart is appended (in
		// Discord order) rather than pre-empting the space's own ordering.
		expect(categories?.[1]?.name).toBe("announcements");
		expect(categories?.[1]?.children).toEqual([roomOf(rooms, CHANNEL_3)]);
	});

	test("ST07: subset bridges only place allowlisted channels", async () => {
		repo = setupRepo("subset");
		roomy = new MockRoomyGateway();
		repo.addToAllowlist(SPACE_A, CHANNEL, GUILD);
		const roomId = newUlid();
		repo.registerMapping(SPACE_A, "channel", CHANNEL, roomId);
		// A mapping exists for an un-allowlisted channel (it was bridged
		// before being removed); it must not be placed.
		repo.registerMapping(SPACE_A, "channel", CHANNEL_2, newUlid());

		await syncInitialStructure(makeGuild(), repo, roomy, subsetConfig);

		const categories = sidebarEvents()[0]?.categories;
		expect(categories).toHaveLength(1);
		expect(categories?.[0]?.children).toEqual([roomId]);
	});

	test("ST08: sends no event when no channel is bridged, and stays retryable", async () => {
		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);

		// No rooms mapped yet: nothing written, and the claim released so the
		// one initial sync still happens once rooms exist.
		expect(sidebarEvents()).toHaveLength(0);
		expect(repo.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(false);

		mapBridgedChannels(repo);
		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);

		expect(sidebarEvents()).toHaveLength(1);
		expect(repo.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(true);

		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);
		expect(sidebarEvents()).toHaveLength(1);
	});

	test("ST09: a failed write keeps the claim so structure is never applied twice", async () => {
		mapBridgedChannels(repo);
		const failing: RoomyGateway = {
			sendEvent: async () => {
				throw new Error("XRPC failed (503)");
			},
			sendEvents: async () => {},
			getSidebar: async () => ({ categories: [] }),
			subscribe: async () => {},
			unsubscribe: async () => {},
			disconnectAll: async () => {},
		};
		await syncInitialStructure(makeGuild(), repo, failing, fullConfig);

		// Claimed but not applied: the write may have reached the space, so a
		// retry could apply the structure a second time. The claim stays, and
		// `applied_at` is null.
		expect(repo.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(true);

		await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);
		expect(sidebarEvents()).toHaveLength(0);
	});

	test("CAP04: syncs no structure when over capacity", async () => {
		setCapacityGate({ isEnabled: async () => false });
		try {
			mapBridgedChannels(repo);

			await syncInitialStructure(makeGuild(), repo, roomy, fullConfig);

			expect(sidebarEvents()).toHaveLength(0);
			expect(repo.hasClaimedStructureSync(GUILD, SPACE_A)).toBe(false);
		} finally {
			resetCapacityGate();
		}
	});
});

describe("readGuildStructure", () => {
	test("reads categories in position order and excludes threads", async () => {
		const guild = makeGuild();
		const channels = [
			...(await guild.getGuild(GUILD))!.channels!,
			makeThread({ id: THREAD, parentId: CHANNEL }),
		];
		const discord = FileDiscordDataSource.fromData({
			guild: { id: GUILD, channels },
			channels,
			messages: {},
		});

		const structure = await readGuildStructure(discord, GUILD);

		expect(structure.categories.map((c) => c.name)).toEqual([
			"announcements",
			"chat",
		]);
		// Threads carry their parent CHANNEL in parentId, not a category —
		// including one here would file the thread under "announcements".
		expect(structure.channels.map((c) => c.id)).not.toContain(THREAD);
		expect(structure.channels.map((c) => c.id)).toContain(CHANNEL_2);
	});
});
