/**
 * Unit tests for message-ingestion.ts
 *
 * Covers: MI01–MI16 — basic sync, fan-out, dedup, system messages,
 * thread starters, mentions, attachments, backfill restriction, subset mode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Did, newUlid } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import {
	resetCapacityGate,
	setCapacityGate,
} from "../../roomy/capacity.ts";
import { ingestDiscordMessage } from "../message-ingestion.ts";
import {
	CHANNEL,
	CHANNEL_2,
	CHANNEL_3,
	GUILD,
	MESSAGE_WITH_FILE,
	MESSAGE_WITH_IMAGE,
	MESSAGE_WITH_VIDEO,
	makeForwardMessage,
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
import { decodeRichText, expectToBe, expectToBeDefined } from "./utils.ts";

/** Extract the createMessage event from a gateway (skip profile sync events). */
function createMessageEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.message.createMessage.v0");
}

/** Extract the forwardMessages event. */
function forwardMessageEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.message.forwardMessages.v0");
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
		const rich = decodeRichText(event.body);
		expect(rich.text).toContain("@Test User");
		expect(rich.didMentions).toContain(`did:discord:${USER_ID}`);
		expect(rich.text).toContain("#general");
		expect(rich.roomRefs).toEqual([
			{ spaceId: SPACE_A, roomId: ROOMY_CHANNEL_ULID },
		]);
	});

	test("MI14b: strips custom emoji from content", async () => {
		const msg = makeMessage({
			id: "1111111119",
			content: "This is <:blob:999999999999999999> amazing!",
		});

		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		const rich = decodeRichText(event.body);
		expectToBe(rich.text, "This is  amazing!");
	});

	// MI14c: A bridged channel/thread referenced via <#id> in the content gets
	// a roomRef/link facet even when it's absent from mentionChannelIds and its
	// display name can't be resolved (Discord omits threads from mention
	// channels, and name resolution may fail). Previously this rendered as
	// plaintext "#snowflake" with no link to the bridged Roomy room.
	test("MI14c: bridges a thread/channel <#id> mention as a link even without mentionChannelIds", async () => {
		// Mention a THREAD that IS bridged, but is not in mentionChannelIds (Discord
		// omits threads from that field). Its display name comes from a content
		// scan + resolver, and it must get a roomRef/link to the bridged Roomy room.
		const threadId = "222222222222222222";
		mapThread(repo, threadId, "01HXBRIDGEDTHREADULID");
		const msg = makeMessage({
			id: "1111111120",
			content: `look at <#${threadId}>`,
			// no mentionChannelIds
		});
		const resolveChannelName = async (_id: string) => "announcements";

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
		const rich = decodeRichText(event.body);
		expect(rich.text).toContain("#announcements");
		expect(rich.roomRefs).toEqual([
			{ spaceId: SPACE_A, roomId: "01HXBRIDGEDTHREADULID" },
		]);
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

		// Mapping is stored on the thread starter message snowflake with a
		// composite key so the Roomy→Discord router can dedupe the echo when
		// the forward event is delivered back to us.
		const mappedRoomyId = repo.getRoomyId(SPACE_A, "message", msg.id);
		expect(mappedRoomyId).toBe(`${event.id}:${ROOMY_MESSAGE_ULID}`);
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
		const rich = decodeRichText(event.body);
		expectToBe(rich.text, longContent);
	});
});

describe("ingestDiscordMessage — webhook echo prevention", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;
	const WEBHOOK_ID = "999888777666555444";

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
		// Register a webhook for the channel — simulates ensureWebhook
		// reusing a webhook from a previous bridge instance.
		repo.setWebhookToken(CHANNEL, WEBHOOK_ID, "fake-token");
	});

	// WE01: Live ingestion skips messages from our own webhook (echo prevention)
	test("WE01: live ingestion skips own webhook messages", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			webhookId: WEBHOOK_ID,
			content: "echo from our webhook",
		});
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// WE02: Backfill ingests own-webhook messages (historical import)
	test("WE02: backfill ingests own-webhook messages not yet mapped", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			webhookId: WEBHOOK_ID,
			content: "historical webhook message from previous bridge",
		});
		// backfill=true — should NOT skip just because it's our webhook
		const result = await ingestDiscordMessage(
			msg,
			repo,
			roomy,
			undefined,
			undefined,
			undefined,
			true, // backfill
		);

		expect(result).toEqual({ synced: 1, skipped: 0 });
		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expect(decodeRichText(event.body).text).toBe(
			"historical webhook message from previous bridge",
		);
	});

	// WE03: Backfill still skips own-webhook messages that are already mapped
	// (e.g. the current bridge sent them live and the router registered the mapping)
	test("WE03: backfill skips own-webhook messages already mapped to this space", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			webhookId: WEBHOOK_ID,
			content: "already bridged by current instance",
		});
		// Simulate the router having already registered a mapping for this
		// Discord message (it was sent as a webhook by the current bridge).
		mapMessage(repo, MSG_ID, ROOMY_MESSAGE_ULID);

		const result = await ingestDiscordMessage(
			msg,
			repo,
			roomy,
			undefined,
			undefined,
			undefined,
			true, // backfill
		);

		expect(result).toEqual({ synced: 0, skipped: 1 });
	});
});

describe("ingestDiscordMessage — forwarded messages (HAS_SNAPSHOT flag)", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo); // target channel (CHANNEL) → ROOMY_CHANNEL_ULID
	});

	// FW01: A Discord forward (HAS_SNAPSHOT flag) forwards the original
	// message into the target channel's Roomy room.
	test("FW01: forwards original message when a Discord message is forwarded", async () => {
		const originalId = "6666666666";
		const sourceChannelId = CHANNEL_2;
		const sourceRoomUlid = newUlid();
		mapMessage(repo, originalId, ROOMY_MESSAGE_ULID);
		repo.registerMapping(SPACE_A, "channel", sourceChannelId, sourceRoomUlid);

		const msg = makeForwardMessage(originalId, CHANNEL, sourceChannelId);
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 1, skipped: 0 });

		const event = forwardMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expectToBe(event.$type, "space.roomy.message.forwardMessages.v0");
		expect(event.room).toBe(ROOMY_CHANNEL_ULID); // target room
		expect(event.messageIds).toEqual([ROOMY_MESSAGE_ULID]);
		expect(event.fromRoomId).toBe(sourceRoomUlid);

		// Composite mapping so the Roomy→Discord router can dedupe the echo.
		const mappedRoomyId = repo.getRoomyId(SPACE_A, "message", msg.id);
		expect(mappedRoomyId).toBe(`${event.id}:${ROOMY_MESSAGE_ULID}`);
	});

	// FW02: Forward is skipped when the original message was never synced to
	// the target space.
	test("FW02: skips forward when original message not synced", async () => {
		const originalId = "6666666666";
		const sourceChannelId = CHANNEL_2;
		const sourceRoomUlid = newUlid();
		repo.registerMapping(SPACE_A, "channel", sourceChannelId, sourceRoomUlid);

		const msg = makeForwardMessage(originalId, CHANNEL, sourceChannelId);
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(forwardMessageEvent(roomy, SPACE_A)).toBeUndefined();
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// FW03: Forward is skipped when the target channel's room is not mapped.
	test("FW03: skips forward when target channel room not bridged", async () => {
		const originalId = "6666666666";
		const sourceChannelId = CHANNEL_2;
		const sourceRoomUlid = newUlid();
		mapMessage(repo, originalId, ROOMY_MESSAGE_ULID);
		repo.registerMapping(SPACE_A, "channel", sourceChannelId, sourceRoomUlid);

		// CHANNEL_3 has no room mapping.
		const msg = makeForwardMessage(originalId, CHANNEL_3, sourceChannelId);
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(forwardMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// FW04: Forward is skipped when the source channel's room is not mapped.
	test("FW04: skips forward when source channel room not bridged", async () => {
		const originalId = "6666666666";
		const sourceChannelId = CHANNEL_2;
		mapMessage(repo, originalId, ROOMY_MESSAGE_ULID);

		const msg = makeForwardMessage(originalId, CHANNEL, sourceChannelId);
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(forwardMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// FW05: Type 26 is NOT a forward — it is INTERACTION_PREMIUM_UPSELL, a
	// system message. Regression guard: the old code keyed forward detection
	// on `type === 26`, which never matched real forwards (they are type 0 +
	// HAS_SNAPSHOT flag) and would have misclassified premium-upsell system
	// messages as forwards.
	test("FW05: type 26 (INTERACTION_PREMIUM_UPSELL) is not treated as a forward", async () => {
		const originalId = "6666666666";
		const sourceChannelId = CHANNEL_2;
		const sourceRoomUlid = newUlid();
		mapMessage(repo, originalId, ROOMY_MESSAGE_ULID);
		repo.registerMapping(SPACE_A, "channel", sourceChannelId, sourceRoomUlid);

		const msg = makeMessage({
			id: "1111111118",
			channelId: CHANNEL,
			guildId: GUILD,
			type: 26, // INTERACTION_PREMIUM_UPSELL
			content: "",
			messageReference: {
				messageId: originalId,
				channelId: sourceChannelId,
				guildId: GUILD,
			},
		});
		const result = await ingestDiscordMessage(msg, repo, roomy);

		// Not a forward: no forwardMessages event. The message falls through
		// to the normal path (where its messageReference becomes a reply
		// attachment) — the old code would have emitted a forward event.
		expect(forwardMessageEvent(roomy, SPACE_A)).toBeUndefined();
		expect(result).toEqual({ synced: 1, skipped: 0 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeDefined();
	});
});

describe("ingestDiscordMessage — capacity enforcement", () => {
	// The module-level capacity gate defaults to always-enabled; these tests
	// install a disabled gate and verify ingestion halts for the space.
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		setCapacityGate({ isEnabled: async () => false });
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	afterEach(() => {
		resetCapacityGate();
	});

	test("CAP01: skips the message when the guild is over capacity", async () => {
		const msg = makeMessage({
			id: "1111111119",
			channelId: CHANNEL,
			guildId: GUILD,
			content: "hello",
		});
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	test("CAP02: skips forwards when the guild is over capacity", async () => {
		const originalId = "6666666666";
		const sourceChannelId = CHANNEL_2;
		const sourceRoomUlid = newUlid();
		mapMessage(repo, originalId, ROOMY_MESSAGE_ULID);
		repo.registerMapping(SPACE_A, "channel", sourceChannelId, sourceRoomUlid);

		const msg = makeForwardMessage(originalId, CHANNEL, sourceChannelId);
		const result = await ingestDiscordMessage(msg, repo, roomy);

		expect(result).toEqual({ synced: 0, skipped: 1 });
		expect(forwardMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});
});
