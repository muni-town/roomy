/**
 * Unit tests for message-ingestion.ts
 *
 * Covers: MI01–MI17 — basic sync, fan-out, dedup, system messages,
 * thread starters, mentions, attachments, embeds, backfill restriction,
 * subset mode, and messages whose body comes only from a poll, components,
 * or a Lottie sticker.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { createBot, Intents } from "@discordeno/bot";
import { Did, newUlid } from "@roomy-space/sdk";
import { normalizeMessage } from "../../discord/normalizers.ts";
import { desiredProperties } from "../../discord/types.ts";
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
import {
	decodeBodyString,
	decodeRichText,
	expectToBe,
	expectToBeDefined,
} from "./utils.ts";

/** Extract the createMessage event from a gateway (skip profile sync events). */
function createMessageEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.message.createMessage.v0");
}

/** Extract the forwardMessages event. */
function forwardMessageEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.message.forwardMessages.v0");
}

// discordeno copies only the fields `desiredProperties.message` requests, so
// these tests drive raw gateway payloads through the real transformer: a
// hand-built DiscordMessageData fixture would keep passing after a field is
// removed from that object.
const GATEWAY_BOT_TOKEN = "MTQ3MzQ3NjE3MzM1MzcxMzc0NA.fake.fake";
const gatewayBot = createBot({
	token: GATEWAY_BOT_TOKEN,
	intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent,
	desiredProperties,
});

/** Transform a raw MESSAGE_CREATE payload and normalize it as the bridge does. */
function fromGateway(payload: Record<string, unknown>) {
	return normalizeMessage(
		gatewayBot.transformers.message(gatewayBot, { message: payload } as never),
	);
}

/** All text in a rich-text body, including list items. */
function bodyText(roomy: MockRoomyGateway, spaceDid: string): string {
	const event = createMessageEvent(roomy, spaceDid);
	expectToBeDefined(event);
	const doc = JSON.parse(decodeBodyString(event.body)) as {
		blocks?: { text?: string; items?: { text?: string }[] }[];
	};
	return (doc.blocks ?? [])
		.flatMap((block) => [
			block.text ?? "",
			...(block.items ?? []).map((item) => item.text ?? ""),
		])
		.filter((text) => text.length > 0)
		.join("\n");
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
				{ id: "1001", name: "thinking", formatType: 2 }, // PNG sticker
				{ id: "1002", name: "party", formatType: 4 }, // GIF sticker
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

describe("ingestDiscordMessage — embeds", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	// EC05: Services post a message whose only payload is an embed. Empty
	// content and no attachments must not drop it.
	test("EC05: syncs a message whose only content is an embed", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			content: "",
			embeds: [
				{
					url: "https://example.com/article",
					title: "An article",
					description: "What it says",
					color: 5814783,
				},
			],
		});

		const result = await ingestDiscordMessage(msg, repo, roomy);
		expect(result).toEqual({ synced: 1, skipped: 0 });

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expectToBe(event.$type, "space.roomy.message.createMessage.v0");
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expectToBeDefined(attExt);
		const attachments = attExt.attachments;
		expect(attachments).toHaveLength(1);
		expectToBe(attachments[0]?.$type, "space.roomy.attachment.link.v0");
		expect(attachments[0].uri).toBe("https://example.com/article");
		expect(attachments[0].showPreview).toBe(true);
	});

	// EC06: An embed without a url (e.g. a bot's image-only card) has no link
	// to attach, but the message itself is still a message.
	test("EC06: syncs an embed without a url, with no attachments", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			content: "",
			embeds: [{ title: "An article" }],
		});

		const result = await ingestDiscordMessage(msg, repo, roomy);
		expect(result).toEqual({ synced: 1, skipped: 0 });

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expect(
			event.extensions?.["space.roomy.extension.attachments.v0"],
		).toBeUndefined();
	});

	// EC07: A link unfurl whose url is already in the content — the body
	// yields the link row, so an attachment would render the card twice.
	test("EC07: does not attach a link already present in the content", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			content: "worth reading https://example.com/article",
			embeds: [{ url: "https://example.com/article" }],
		});

		const result = await ingestDiscordMessage(msg, repo, roomy);
		expect(result).toEqual({ synced: 1, skipped: 0 });
		expect(
			createMessageEvent(roomy, SPACE_A)?.extensions?.[
				"space.roomy.extension.attachments.v0"
			],
		).toBeUndefined();
	});

	// EC08: Distinct urls each get their own card; a repeated url does not.
	test("EC08: attaches one link per distinct embed url", async () => {
		const msg = makeMessage({
			id: MSG_ID,
			content: "",
			embeds: [
				{ url: "https://example.com/one" },
				{ url: "https://example.com/two" },
				{ url: "https://example.com/one" },
			],
		});

		await ingestDiscordMessage(msg, repo, roomy);

		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expectToBeDefined(attExt);
		const attachments = attExt.attachments;
		expect(attachments).toHaveLength(2);
		expectToBe(attachments[0]?.$type, "space.roomy.attachment.link.v0");
		expectToBe(attachments[1]?.$type, "space.roomy.attachment.link.v0");
		expect(attachments[0].uri).toBe("https://example.com/one");
		expect(attachments[1].uri).toBe("https://example.com/two");
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
	// channels, and name resolution may fail).
	test("MI14c: bridges a thread/channel <#id> mention as a link even without mentionChannelIds", async () => {
		// Mention a THREAD that IS bridged, but is not in mentionChannelIds (Discord
		// omits threads from that field). Its display name comes from a content
		// scan + resolver, and it must get a roomRef/link to the bridged Roomy room.
		const threadId = "222222222222222222";
		mapThread(repo, threadId, ROOMY_MESSAGE_ULID_2);
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
			{ spaceId: SPACE_A, roomId: ROOMY_MESSAGE_ULID_2 },
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

		// The thread starter's snowflake maps to the Roomy message the forward
		// created; the router's composite dedup key lives under its own kind.
		expect(repo.getRoomyId(SPACE_A, "message", msg.id)).toBe(event.id);
		expect(repo.getRoomyId(SPACE_A, "forward", msg.id)).toBe(
			`${event.id}:${ROOMY_MESSAGE_ULID}`,
		);
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

		// The forward's snowflake maps to the Roomy message the forward
		// created; the router's composite dedup key lives under its own kind.
		expect(repo.getRoomyId(SPACE_A, "message", msg.id)).toBe(event.id);
		expect(repo.getRoomyId(SPACE_A, "forward", msg.id)).toBe(
			`${event.id}:${ROOMY_MESSAGE_ULID}`,
		);
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
	// system message. Forward detection keys on type 0 + the HAS_SNAPSHOT
	// flag, never on `type === 26`: a real forward is type 0 + HAS_SNAPSHOT,
	// and a type-26 premium-upsell would otherwise be misclassified.
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
		// attachment).
		expect(forwardMessageEvent(roomy, SPACE_A)).toBeUndefined();
		expect(result).toEqual({ synced: 1, skipped: 0 });
		expect(createMessageEvent(roomy, SPACE_A)).toBeDefined();
	});

	// FW06: A reply to a bridged forward resolves to the Roomy message the
	// forward created — the forward event's own ULID, never a composite key.
	test("FW06: reply to a bridged forward targets the forward's Roomy message", async () => {
		const originalId = "6666666668";
		const sourceChannelId = CHANNEL_2;
		const sourceRoomUlid = newUlid();
		mapMessage(repo, originalId, ROOMY_MESSAGE_ULID);
		repo.registerMapping(SPACE_A, "channel", sourceChannelId, sourceRoomUlid);

		const forward = makeForwardMessage(originalId, CHANNEL, sourceChannelId);
		await ingestDiscordMessage(forward, repo, roomy);
		const fwdEvent = forwardMessageEvent(roomy, SPACE_A);
		expectToBeDefined(fwdEvent);
		const fwdEventId = fwdEvent.id;

		const reply = makeMessage({
			id: "6666666669",
			channelId: CHANNEL,
			content: "replying to the forward",
			messageReference: {
				messageId: forward.id,
				channelId: CHANNEL,
				guildId: GUILD,
			},
		});
		const result = await ingestDiscordMessage(reply, repo, roomy);

		expect(result).toEqual({ synced: 1, skipped: 0 });
		const event = createMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		expectToBeDefined(attExt);
		expect(attExt.attachments).toEqual([
			{ $type: "space.roomy.attachment.reply.v0", target: fwdEventId },
		]);
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

describe("ingestDiscordMessage — messages with no content", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
		mapChannel(repo);
	});

	/** A MESSAGE_CREATE payload with nothing renderable in it. */
	const emptyPayload = {
		id: MSG_ID,
		channel_id: CHANNEL,
		guild_id: GUILD,
		type: 0,
		content: "",
		timestamp: "2026-10-20T06:03:00.270Z",
		author: { id: USER_ID, username: "pollbot", discriminator: "0" },
		attachments: [],
		embeds: [],
		mentions: [],
		mention_roles: [],
	};

	test("MI17a: a poll-only message renders its question and answers", async () => {
		const message = fromGateway({
			...emptyPayload,
			poll: {
				question: { text: "Which room next?" },
				answers: [
					{ answer_id: 1, poll_media: { text: "Garden" } },
					{ answer_id: 2, poll_media: { text: "Library" } },
				],
				expiry: "2026-10-27T00:00:00.000Z",
				allow_multiselect: false,
				layout_type: 1,
			},
		});

		const result = await ingestDiscordMessage(message, repo, roomy);

		expect(result).toEqual({ synced: 1, skipped: 0 });
		const text = bodyText(roomy, SPACE_A);
		expect(text).toContain("Poll: Which room next?");
		expect(text).toContain("Garden");
		expect(text).toContain("Library");
	});

	test("MI17b: a component-only message renders its button and select labels", async () => {
		const message = fromGateway({
			...emptyPayload,
			components: [
				{
					type: 1,
					components: [
						{ type: 2, style: 2, label: "Yes", custom_id: "yes" },
						{ type: 2, style: 2, label: "No", custom_id: "no" },
					],
				},
				{
					type: 3,
					custom_id: "role",
					placeholder: "Pick a role",
					options: [
						{ label: "Artist", value: "artist" },
						{ label: "Writer", value: "writer" },
					],
				},
			],
		});

		const result = await ingestDiscordMessage(message, repo, roomy);

		expect(result).toEqual({ synced: 1, skipped: 0 });
		expect(bodyText(roomy, SPACE_A)).toContain(
			"Message components: Yes, No, Pick a role, Artist, Writer",
		);
	});

	test("MI17c: a Lottie sticker message syncs as a link, not a skip", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const message = fromGateway({
				...emptyPayload,
				sticker_items: [
					{
						id: "749054660769218631",
						name: "Wumpus Hello",
						format_type: 3,
					},
				],
			});

			const result = await ingestDiscordMessage(message, repo, roomy);

			expect(result).toEqual({ synced: 1, skipped: 0 });
			const event = createMessageEvent(roomy, SPACE_A);
			expectToBeDefined(event);
			expect(
				event.extensions?.["space.roomy.extension.attachments.v0"]
					?.attachments,
			).toEqual([
				{
					$type: "space.roomy.attachment.link.v0",
					uri: "https://cdn.discordapp.com/stickers/749054660769218631.json",
					showPreview: true,
				},
			]);
			expect(bodyText(roomy, SPACE_A)).toContain("Sticker: Wumpus Hello");

			const skipped = warnSpy.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.includes(MSG_ID));
			expect(skipped).toEqual([]);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("MI17d: a message with nothing renderable still skips, naming its shape", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await ingestDiscordMessage(
				fromGateway(emptyPayload),
				repo,
				roomy,
			);

			expect(result).toEqual({ synced: 0, skipped: 1 });
			expect(createMessageEvent(roomy, SPACE_A)).toBeUndefined();

			const line = warnSpy.mock.calls
				.map((call) => String(call[0]))
				.find((line) => line.includes(MSG_ID));
			expectToBeDefined(line);
			expect(line).toContain("type=0");
			expect(line).toContain("poll=none");
			expect(line).toContain("components=0");
			expect(line).toContain("stickers=0");
		} finally {
			warnSpy.mockRestore();
		}
	});
});
