/**
 * Unit tests for message-ingestion.ts
 *
 * Covers: MI01–MI16 — basic sync, fan-out, dedup, system messages,
 * thread starters, mentions, attachments, backfill restriction, subset mode.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Did } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import { ingestDiscordMessage } from "../message-ingestion.ts";
import {
	CHANNEL,
	GUILD,
	MESSAGE_WITH_FILE,
	MESSAGE_WITH_IMAGE,
	MESSAGE_WITH_VIDEO,
	makeMessage,
	makeReplyMessage,
	makeThreadStarterMessage,
	makeUser,
	ROOMY_CHANNEL_ULID,
	ROOMY_MESSAGE_ULID,
	ROOMY_MESSAGE_ULID_2,
	SPACE_A,
	SPACE_B,
	USER_ID,
} from "./helpers/test-data.ts";
import { expectToBe, expectToBeDefined } from "./utils.ts";

/** Extract the createMessage event from a gateway (skip profile sync events). */
function createMessageEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.message.createMessage.v0");
}

/** Extract the forwardMessages event. */
function forwardMessageEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.message.forwardMessages.v0");
}

/** Decode the body data from a createMessage event. */
function decodeBody(event: { body: { data: { $bytes: string } } }): string {
	const bytes: { $bytes: string } = event.body.data;
	return atob(bytes.$bytes);
}

/** Convenience: create a fresh repository with a pre-configured bridge. */
function setupRepo(
	mode: "full" | "subset" = "full",
	spaceDid: string = SPACE_A,
): BridgeRepository {
	const repo = BridgeRepository.open(":memory:");
	repo.upsertBridgeConfig(GUILD, spaceDid, mode);
	return repo;
}

/** Set up channel mapping so ingest can find its Roomy room. */
function mapChannel(
	repo: BridgeRepository,
	channelId: string = CHANNEL,
	roomyUlid: string = ROOMY_CHANNEL_ULID,
	spaceDid: string = SPACE_A,
) {
	repo.registerMapping(spaceDid, "channel", channelId, roomyUlid);
}

function mapMessage(
	repo: BridgeRepository,
	discordId: string,
	roomyId: string = ROOMY_MESSAGE_ULID,
	spaceDid: string = SPACE_A,
) {
	repo.registerMapping(spaceDid, "message", discordId, roomyId);
}

function mapThread(
	repo: BridgeRepository,
	threadId: string,
	roomyId: string = ROOMY_MESSAGE_ULID_2,
	spaceDid: string = SPACE_A,
) {
	repo.registerMapping(spaceDid, "thread", threadId, roomyId);
}

const MSG_ID = "987654321";

describe("ingestDiscordMessage — basic sync", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	// MI01: Basic message sync to one target space
	test("MI01: syncs a basic message to one space", async () => {
		const msg = makeMessage({ id: MSG_ID });
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 1, skipped: 0 });

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expectToBe(event.$type, "space.roomy.message.createMessage.v0");
		expect(
			event.extensions?.["space.roomy.extension.discordMessageOrigin.v0"]
				?.snowflake,
		).toBe(MSG_ID);
		expectToBe(
			event.extensions?.["space.roomy.extension.authorOverride.v0"]?.did,
			Did.assert(`did:discord:${USER_ID}`),
		);

		// Mapping registered
		expect(repo.getRoomyId(SPACE_A, "message", MSG_ID)).toBe(event.id);

		// Cursor advanced
		expect(repo.getChannelCursor(SPACE_A, CHANNEL)?.lastMessageId).toBe(MSG_ID);
	});

	// MI02: Fan-out to multiple spaces
	test("MI02: fans out message to multiple bridged spaces", async () => {
		repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
		mapChannel(repo, CHANNEL, ROOMY_CHANNEL_ULID, SPACE_B);
		roomy = new MockRoomyGateway();

		const msg = makeMessage({ id: MSG_ID });
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 2, skipped: 0 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeDefined();
		expect(createMessageEvent(roomy, SPACE_B)).toBeDefined();
	});

	// MI03: Dedup — duplicate skipped
	test("MI03: skips duplicate message (already has mapping)", async () => {
		mapMessage(repo, MSG_ID);
		const msg = makeMessage({ id: MSG_ID });
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// MI04: No target space for channel
	test("MI04: skips when channel not bridged to any space", async () => {
		const unbridgedRepo = BridgeRepository.open(":memory:");
		const msg = makeMessage({ id: MSG_ID });
		const result = await ingestDiscordMessage(msg, unbridgedRepo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// MI05: Missing Roomy room mapping
	test("MI05: skips if channel has no Roomy room mapping", async () => {
		const unmappedChannel = "999999999999999999";
		const msg = makeMessage({ id: MSG_ID, channelId: unmappedChannel });
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// MI06: System messages skipped
	test("MI06: skips system messages (ThreadCreated, ChannelNameChange)", async () => {
		const msg = makeMessage({ id: MSG_ID, type: 18 }); // ThreadCreated
		const result = await ingestDiscordMessage(msg, repo, roomy);
		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// MI07: Message with no content and no attachments skipped
	test("MI07: skips message with no content and no attachments", async () => {
		const msg = makeMessage({ id: MSG_ID, content: "", attachments: [] });
		const result = await ingestDiscordMessage(msg, repo, roomy);
		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});
});

describe("ingestDiscordMessage — cursor", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	// MI09: Cursor advancement
	test("MI09: advances cursor after successful sync", async () => {
		const msg = makeMessage({ id: MSG_ID });
		await ingestDiscordMessage(msg, repo, roomy);

		const cursor = repo.getChannelCursor(SPACE_A, CHANNEL);
		expect(cursor?.lastMessageId).toBe(MSG_ID);
	});
});

describe("ingestDiscordMessage — attachments", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	// MI11: Attachments
	test("MI11a: syncs message with image attachment", async () => {
		const msg = MESSAGE_WITH_IMAGE;
		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.message.createMessage.v0");
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expectToBeDefined(attExt);
		const attachments = attExt.attachments;
		expect(attachments).toHaveLength(1);
		expectToBe(attachments[0]?.$type, "space.roomy.attachment.image.v0");
		expect(attachments[0].mimeType).toBe("image/png");
	});

	test("MI11b: syncs message with video attachment", async () => {
		const msg = MESSAGE_WITH_VIDEO;
		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.message.createMessage.v0");
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expectToBeDefined(attExt);
		const attachments = attExt.attachments;
		expect(attachments).toHaveLength(1);
		expectToBe(attachments[0]?.$type, "space.roomy.attachment.video.v0");
	});

	test("MI11c: syncs message with generic file attachment", async () => {
		const msg = MESSAGE_WITH_FILE;
		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.message.createMessage.v0");
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expectToBeDefined(attExt);
		const attachments = attExt.attachments;
		expect(attachments).toHaveLength(1);
		expectToBe(attachments[0]?.$type, "space.roomy.attachment.file.v0");
		expect(attachments[0].name).toBe("doc.pdf");
	});

	test("MI11d: syncs reply attachment", async () => {
		const replyTarget = "5555555555";
		mapMessage(repo, replyTarget, ROOMY_MESSAGE_ULID);

		const msg = makeReplyMessage(replyTarget);
		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.message.createMessage.v0");
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expectToBeDefined(attExt);
		const attachments = attExt.attachments;
		expect(attachments).toHaveLength(1);
		expectToBe(attachments[0]?.$type, "space.roomy.attachment.reply.v0");
		expect(attachments[0].target).toBe(ROOMY_MESSAGE_ULID);
	});

	test("MI11e: skips reply when target message not synced", async () => {
		const replyTarget = "5555555555";
		const msg = makeReplyMessage(replyTarget);
		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expectToBe(event.$type, "space.roomy.message.createMessage.v0");
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expect(attExt).toBeUndefined();
	});
});

describe("ingestDiscordMessage — stickers", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	// EC01: Message with only stickers
	test("EC01: syncs message with sticker items (no text/attachments)", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			content: "",
			stickerItems: [
				{ id: "1001", formatType: 2 }, // PNG sticker
				{ id: "1002", formatType: 4 }, // GIF sticker
			],
		});

		const result = await ingestDiscordMessage(msg, repo, roomy);
		expect(result).toEqual({ synced: 1, skipped: 0 });

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.message.createMessage.v0");
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expectToBeDefined(attExt);
		const attachments = attExt.attachments;
		expect(attachments).toHaveLength(2);
		expectToBe(attachments[0]?.$type, "space.roomy.attachment.image.v0");
		expectToBe(attachments[1]?.$type, "space.roomy.attachment.image.v0");
		expectToBe(attachments[0]?.mimeType, "image/png");
		expectToBe(attachments[1]?.mimeType, "image/gif");
	});

	// EC02: Empty content without attachments or stickers skipped
	test("EC02: skips empty content without attachments (no sticker)", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			content: "",
			attachments: [],
			stickerItems: [],
		});
		const result = await ingestDiscordMessage(msg, repo, roomy);
		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});
});

describe("ingestDiscordMessage — mention resolution", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	// MI14: Mention resolution
	test("MI14a: resolves user and channel mentions", async () => {
		const msg = makeMessage({
			id: "1111111118",
			content: "Hey <@111111111111111111>, check <#123456789012345678>",
			mentions: [
				makeUser({ id: USER_ID, name: "testuser", globalName: "Test User" }),
			],
			mentionChannelIds: [CHANNEL],
		});

		const resolveChannelName = async (_snowflake: string) => "general";

		await ingestDiscordMessage(
			msg,
			repo,
			roomy,
			undefined,
			undefined,
			resolveChannelName,
		);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		const decoded = decodeBody(event);
		expect(decoded).toContain("[@Test User]()");
		expect(decoded).toContain(`[#general](${ROOMY_CHANNEL_ULID})`);
	});

	test("MI14b: strips custom emoji from content", async () => {
		const msg = makeMessage({
			id: "1111111119",
			content: "This is <:blob:999999999999999999> amazing!",
		});

		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		const decoded = decodeBody(event);
		expectToBe(decoded, "This is  amazing!");
	});
});

describe("ingestDiscordMessage — threadStarterMessage", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// MI12: ThreadStarterMessage forwards original message to thread room
	test("MI12a: forwards original message when both thread and original are mapped", async () => {
		const originalId = "3333333333";
		const threadId = "423456789012345678";
		const parentChannelId = CHANNEL;

		mapChannel(repo, parentChannelId, ROOMY_CHANNEL_ULID);
		mapThread(repo, threadId, ROOMY_MESSAGE_ULID_2);
		mapMessage(repo, originalId, ROOMY_MESSAGE_ULID);

		const msg = makeThreadStarterMessage(originalId, threadId, parentChannelId);
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 1, skipped: 0 });

		const event = forwardMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expectToBe(event.$type, "space.roomy.message.forwardMessages.v0");
		expect(event.room).toBe(ROOMY_MESSAGE_ULID_2);
		expect(event.messageIds).toEqual([ROOMY_MESSAGE_ULID]);
		expect(event.fromRoomId).toBe(ROOMY_CHANNEL_ULID);
	});

	// MI13: ThreadStarterMessage skips if original not synced
	test("MI13a: skips forwarding when original message not synced", async () => {
		const originalId = "3333333333";
		const threadId = "423456789012345678";
		const parentChannelId = CHANNEL;

		mapChannel(repo, parentChannelId, ROOMY_CHANNEL_ULID);
		mapThread(repo, threadId, ROOMY_MESSAGE_ULID_2);

		const msg = makeThreadStarterMessage(originalId, threadId, parentChannelId);
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(forwardMessageEvent(roomy, SPACE_A)).toBeUndefined();
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	test("MI13b: skips forwarding when thread room not mapped", async () => {
		const originalId = "3333333333";
		const threadId = "423456789012345678";

		mapMessage(repo, originalId, ROOMY_MESSAGE_ULID);

		const msg = makeThreadStarterMessage(originalId, threadId);
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(forwardMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});
});

describe("ingestDiscordMessage — backfill path & subset mode", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	// MI15: Backfill path (spaceDidOverride) restricts to single space
	test("MI15: spaceDidOverride restricts sync to one space", async () => {
		repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
		mapChannel(repo, CHANNEL, ROOMY_CHANNEL_ULID, SPACE_B);
		roomy = new MockRoomyGateway();

		const msg = makeMessage({ id: MSG_ID });
		const result = await ingestDiscordMessage(
			msg,
			repo,
			roomy,
			undefined,
			SPACE_A, // only target SPACE_A
		);

		expect(result).toEqual({ synced: 1, skipped: 0 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeDefined();
		expect(createMessageEvent(roomy, SPACE_B)).toBeUndefined();
	});

	// MI16: Multiple spaces with subset mode
	test("MI16: subset mode only targets allowlisted channels", async () => {
		repo.upsertBridgeConfig(GUILD, SPACE_B, "subset");
		repo.addToAllowlist(SPACE_B, CHANNEL, GUILD);
		mapChannel(repo, CHANNEL, ROOMY_CHANNEL_ULID, SPACE_B);
		roomy = new MockRoomyGateway();

		const msg = makeMessage({ id: MSG_ID, channelId: CHANNEL });
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 2, skipped: 0 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeDefined();
		expect(createMessageEvent(roomy, SPACE_B)).toBeDefined();
	});

	test("MI16b: subset mode skips non-allowlisted channels", async () => {
		const otherChannel = "999999999999999999";
		repo.upsertBridgeConfig(GUILD, SPACE_B, "subset");
		mapChannel(repo, otherChannel, ROOMY_CHANNEL_ULID);
		repo.registerMapping(SPACE_B, "channel", otherChannel, ROOMY_CHANNEL_ULID);
		roomy = new MockRoomyGateway();

		const msg = makeMessage({ id: MSG_ID, channelId: otherChannel });

		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 1, skipped: 0 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeDefined();
		expect(createMessageEvent(roomy, SPACE_B)).toBeUndefined();
	});

	// EC04: Very long message content
	test("EC04: handles very long message content", async () => {
		const longContent = "x".repeat(3000);
		const msg = makeMessage({ id: MSG_ID, content: longContent });

		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		const decoded = decodeBody(event);
		expectToBe(decoded, longContent);
	});
});
