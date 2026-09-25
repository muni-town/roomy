/**
 * Unit tests for RoomyEventRouter (Roomy → Discord direction).
 *
 * Covers: RER01–RER09 — message create/edit/delete/reaction, echo prevention,
 * unbridged-room skipping, profile attribution, and x-dmp-patch edit skipping.
 * Covers: Roomy thread creation → Discord thread creation, echo prevention
 * for Discord-originated threads, message forwarding, and restart-resilient
 * pending thread metadata.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
	Did,
	type Event,
	newUlid,
	serializeBlocks,
	toBytes,
	Ulid,
} from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { FileDiscordSender } from "../../discord/file-sender.ts";
import { FileWebhookManager } from "../../discord/file-webhook-manager.ts";
import { FileProfileResolver } from "../../roomy/file-profile-resolver.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import {
	RoomyEventRouter,
	resolveAttachmentUrl,
} from "../roomy-event-router.ts";
import {
	GUILD,
	ROOMY_CHANNEL_ULID,
	ROOMY_MESSAGE_ULID,
	ROOMY_THREAD_ULID,
	SPACE_A,
	SPACE_B,
	USER_ID,
} from "./helpers/test-data.ts";

const DISCORD_MESSAGE_ID = newUlid();
const DISCORD_CHANNEL_ID = "800000000000000001";
const DISCORD_THREAD_ID = "800000000000000002";
const DISCORD_USER_DID = Did.assert(`did:discord:${USER_ID}`);

function makeTextBody(content: string): {
	mimeType: string;
	data: ReturnType<typeof toBytes>;
} {
	return {
		mimeType: "text/markdown",
		data: toBytes(new TextEncoder().encode(content)),
	};
}

function makeCreateMessageEvent(options: {
	id?: string;
	room?: string;
	content?: string;
	authorDid?: string;
	origin?: { snowflake: string; channelId: string; guildId: string };
	body?: { mimeType: string; data: ReturnType<typeof toBytes> };
	extensions?: Record<string, unknown>;
}): Event {
	const id = options.id ? Ulid.assert(options.id) : newUlid();
	const room = options.room ? Ulid.assert(options.room) : ROOMY_CHANNEL_ULID;
	const extensions: Record<string, unknown> = {};
	if (options.authorDid) {
		extensions["space.roomy.extension.authorOverride.v0"] = {
			$type: "space.roomy.extension.authorOverride.v0",
			did: options.authorDid,
		};
	}
	if (options.origin) {
		extensions["space.roomy.extension.discordMessageOrigin.v0"] = {
			$type: "space.roomy.extension.discordMessageOrigin.v0",
			...options.origin,
		};
	}
	if (options.extensions) {
		Object.assign(extensions, options.extensions);
	}
	return {
		id,
		room,
		$type: "space.roomy.message.createMessage.v0",
		body: options.body ?? makeTextBody(options.content ?? "Hello from Roomy"),
		extensions,
	} satisfies Event;
}

function makeCreateThreadEvent(options: {
	id?: string;
	name?: string;
	defaultAccess?: "read" | "readwrite" | "none";
	origin?: { snowflake: string; channelId: string; guildId: string };
}): Event {
	const id = options.id ? Ulid.assert(options.id) : newUlid();
	const extensions: Record<string, unknown> = {};
	if (options.origin) {
		extensions["space.roomy.extension.discordOrigin.v0"] = {
			$type: "space.roomy.extension.discordOrigin.v0",
			...options.origin,
		};
	}
	return {
		id,
		$type: "space.roomy.room.createRoom.v0",
		kind: "space.roomy.thread",
		name: options.name ?? "Test Thread",
		defaultAccess: options.defaultAccess ?? "readwrite",
		extensions,
	} satisfies Event;
}

function makeCreateRoomLinkEvent(options: {
	id?: string;
	room?: string;
	linkToRoom: string;
	isCreationLink?: boolean;
}): Event {
	const id = options.id ? Ulid.assert(options.id) : newUlid();
	return {
		id,
		room: options.room ? Ulid.assert(options.room) : ROOMY_CHANNEL_ULID,
		$type: "space.roomy.link.createRoomLink.v0",
		linkToRoom: Ulid.assert(options.linkToRoom),
		isCreationLink: options.isCreationLink ?? false,
	} satisfies Event;
}

function makeForwardMessagesEvent(options: {
	id?: string;
	room?: string;
	fromRoomId?: string;
	messageIds?: string[];
}): Event {
	const id = options.id ? Ulid.assert(options.id) : newUlid();
	return {
		id,
		room: options.room ? Ulid.assert(options.room) : ROOMY_CHANNEL_ULID,
		$type: "space.roomy.message.forwardMessages.v0",
		fromRoomId: Ulid.assert(options.fromRoomId ?? ROOMY_CHANNEL_ULID),
		messageIds: options.messageIds?.map((m) => Ulid.assert(m)) ?? [
			ROOMY_MESSAGE_ULID,
		],
	} satisfies Event;
}

function makeMoveMessagesEvent(options: {
	id?: string;
	room?: string;
	toRoomId?: string;
	messageIds?: string[];
}): Event {
	const id = options.id ? Ulid.assert(options.id) : newUlid();
	return {
		id,
		room: options.room ? Ulid.assert(options.room) : ROOMY_CHANNEL_ULID,
		$type: "space.roomy.message.moveMessages.v0",
		toRoomId: Ulid.assert(options.toRoomId ?? newUlid()),
		messageIds: options.messageIds?.map((m) => Ulid.assert(m)) ?? [
			ROOMY_MESSAGE_ULID,
		],
	} satisfies Event;
}

/** Build a `space.roomy.message.deleteMessage.v0` event for a room. */
function makeDeleteMessageEvent(options: {
	room?: string;
	messageId?: string;
	origin?: { snowflake: string; channelId: string; guildId: string };
}): Event {
	const extensions: Record<string, unknown> = {};
	if (options.origin) {
		extensions["space.roomy.extension.discordMessageOrigin.v0"] = {
			$type: "space.roomy.extension.discordMessageOrigin.v0",
			...options.origin,
		};
	}
	return {
		id: newUlid(),
		room: Ulid.assert(options.room ?? ROOMY_CHANNEL_ULID),
		$type: "space.roomy.message.deleteMessage.v0",
		messageId: Ulid.assert(options.messageId ?? ROOMY_MESSAGE_ULID),
		extensions,
	} satisfies Event;
}

function setup(): {
	repo: BridgeRepository;
	roomy: MockRoomyGateway;
	discord: FileDiscordSender;
	webhooks: FileWebhookManager;
	profiles: FileProfileResolver;
	router: RoomyEventRouter;
} {
	const repo = BridgeRepository.open(":memory:");
	repo.upsertBridgeConfig(GUILD, SPACE_A, "full");
	repo.registerMapping(
		SPACE_A,
		"channel",
		DISCORD_CHANNEL_ID,
		ROOMY_CHANNEL_ULID,
	);

	const roomy = new MockRoomyGateway();
	const discord = new FileDiscordSender();
	// Faux reply/forward prefixes need the guild + original message content.
	// The message carries a webhook id because bridged messages are authored
	// by the channel's webhook, not the bot — which the delete path checks.
	discord.setGuildId(DISCORD_CHANNEL_ID, GUILD);
	discord.setMessage(
		DISCORD_CHANNEL_ID,
		DISCORD_MESSAGE_ID,
		"original content",
		`wh_${DISCORD_CHANNEL_ID}`,
	);
	const webhooks = new FileWebhookManager();
	const profiles = new FileProfileResolver({
		[DISCORD_USER_DID]: {
			name: "Bridged User",
			handle: "bridged.bsky.social",
			avatarUrl: "https://example.com/avatar.png",
		},
	});
	const router = new RoomyEventRouter(
		roomy,
		discord,
		webhooks,
		profiles,
		repo,
		{
			fetchAttachment: async (uri) =>
				new TextEncoder().encode(`bytes for ${uri}`),
			queryMessage: async (messageId) => ({
				authorDid: "did:plc:original-author",
				authorName: "Original Author",
				authorHandle: "original.bsky.social",
			}),
		},
	);
	return { repo, roomy, discord, webhooks, profiles, router };
}

describe("RoomyEventRouter", () => {
	beforeEach(() => {});

	/**
	 * RER01: createMessage is bridged to Discord via webhook with the right
	 * channel, content, and profile attribution.
	 */
	test("RER01: bridges createMessage to Discord with webhook attribution", async () => {
		const { roomy, discord, webhooks, router, repo } = setup();
		await router.subscribeToSpace(SPACE_A);

		const event = makeCreateMessageEvent({
			id: ROOMY_MESSAGE_ULID,
			content: "Hello Discord",
			authorDid: DISCORD_USER_DID,
		});
		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(1);
		const sent = discord.sent[0];
		expect(sent).toBeDefined();
		expect(sent?.channelId).toBe(DISCORD_CHANNEL_ID);
		expect(sent?.content).toBe("Hello Discord");
		expect(sent?.options?.username).toBe("Bridged User - @bridged.bsky.social");
		expect(sent?.options?.avatarUrl).toBe("https://example.com/avatar.png");

		// A webhook was ensured for the channel
		expect(webhooks.webhooks.has(DISCORD_CHANNEL_ID)).toBe(true);

		// Mapping registered so Discord→Roomy dedup catches the echo
		const mappedDiscordId = repo.getDiscordId(
			SPACE_A,
			"message",
			ROOMY_MESSAGE_ULID,
		);
		expect(mappedDiscordId).toBe(sent?.messageId);
	});

	/**
	 * RER28: a rich text (blocks+facets) createMessage is decoded and bridged
	 * to Discord as rendered Discord markdown.
	 */
	test("RER28: bridges a rich text createMessage to Discord", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const blocks = [
			{ $type: "space.roomy.richtext.blocks#text", text: "Hello from blocks" },
			{ $type: "space.roomy.richtext.blocks#code", text: "const x = 1;" },
		];
		const body = serializeBlocks(blocks);
		const event = makeCreateMessageEvent({
			id: ROOMY_MESSAGE_ULID,
			body: { mimeType: body.mimeType, data: toBytes(body.data) },
		});

		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(1);
		expect(discord.sent[0]?.content).toBe(
			"Hello from blocks\n```\nconst x = 1;\n```",
		);
	});

	/**
	 * RER33: a legacy text/markdown body containing raw mention anchor HTML
	 * (as produced by the composer's tiptap-markdown serializer) is bridged as
	 * clean text — no `<a` tags, no `data-*` attributes reach Discord.
	 */
	test("RER33: strips raw mention HTML from legacy text/markdown bodies", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const rawHtml =
			'<a href="/user/did:plc:mmyj7mk7kh3jqhw6zs4prbuk" class="mention !no-underline" data-id="did:plc:mmyj7mk7kh3jqhw6zs4prbuk" data-label="Alice" data-mention-suggestion-char="@">@Alice</a>';
		const event = makeCreateMessageEvent({
			id: ROOMY_MESSAGE_ULID,
			body: makeTextBody(rawHtml),
		});

		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(1);
		const content = discord.sent[0]?.content;
		expect(content).toBe("@Alice");
		expect(content).not.toContain("<a");
		expect(content).not.toContain("data-");
	});

	/**
	 * RER34: the same tag-stripping applies to legacy text/plain bodies, so
	 * no producer-regressed body type can leak raw HTML into Discord.
	 */
	test("RER34: strips raw HTML from legacy text/plain bodies", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const event = makeCreateMessageEvent({
			id: ROOMY_MESSAGE_ULID,
			body: {
				mimeType: "text/plain",
				data: toBytes(
					new TextEncoder().encode(
						'<a href="/user/did:plc:abc" data-label="Alice">@Alice</a> hello',
					),
				),
			},
		});

		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(1);
		expect(discord.sent[0]?.content).toBe("@Alice hello");
	});

	/**
	 * RER35: a markdown autolink (`<https://…>`) in a legacy text/markdown body
	 * must reach Discord intact as a bare URL — it is a link, not an HTML tag,
	 * so the stripper must not delete it wholesale.
	 */
	test("RER35: bridges a markdown autolink in legacy markdown as a bare URL", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const event = makeCreateMessageEvent({
			id: ROOMY_MESSAGE_ULID,
			body: makeTextBody(
				"there it is: <https://belgium-atmosphe.re/vidi> try it",
			),
		});

		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(1);
		expect(discord.sent[0]?.content).toBe(
			"there it is: https://belgium-atmosphe.re/vidi try it",
		);
	});

	/**
	 * RER36: HTML-looking text that is neither a tag nor an autolink (e.g.
	 * "I <3 x") passes through untouched — the stripper matches tag-shaped
	 * spans only, so text between `<` and a later `>` survives.
	 */
	test("RER36: keeps non-tag angle-bracket text in legacy markdown", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const event = makeCreateMessageEvent({
			id: ROOMY_MESSAGE_ULID,
			body: makeTextBody("I <3 Roomy <3 bridges"),
		});

		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(1);
		expect(discord.sent[0]?.content).toBe("I <3 Roomy <3 bridges");
	});

	/**
	 * RER02: editMessage updates the bridged Discord message.
	 */
	test("RER02: bridges editMessage to Discord", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const editEvent = {
			id: newUlid(),
			room: ROOMY_CHANNEL_ULID,
			$type: "space.roomy.message.editMessage.v0" as const,
			messageId: ROOMY_MESSAGE_ULID,
			body: makeTextBody("Edited content"),
			extensions: {},
		} satisfies Event;
		await roomy.fireEvent(SPACE_A, editEvent);

		expect(discord.edited).toHaveLength(1);
		expect(discord.edited[0]).toEqual({
			channelId: DISCORD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
			content: "Edited content",
		});
	});

	/**
	 * RER03: deleteMessage removes the bridged Discord message and
	 * clears the mapping.
	 */
	test("RER03: bridges deleteMessage to Discord and clears mapping", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(SPACE_A, makeDeleteMessageEvent({}));

		expect(discord.deleted).toHaveLength(1);
		expect(discord.deleted[0]).toEqual({
			channelId: DISCORD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
			webhook: {
				id: `wh_${DISCORD_CHANNEL_ID}`,
				token: `tok_${DISCORD_CHANNEL_ID}`,
			},
		});
		expect(
			repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID),
		).toBeUndefined();
	});

	/**
	 * RER04: addReaction adds the emoji to the bridged Discord message.
	 */
	test("RER04: bridges addReaction to Discord", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const reactionEvent = {
			id: newUlid(),
			room: ROOMY_CHANNEL_ULID,
			$type: "space.roomy.reaction.addReaction.v0" as const,
			reactionTo: ROOMY_MESSAGE_ULID,
			reaction: "👍",
		} satisfies Event;
		await roomy.fireEvent(SPACE_A, reactionEvent);

		expect(discord.reactionsAdded).toHaveLength(1);
		expect(discord.reactionsAdded[0]).toEqual({
			channelId: DISCORD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
			emoji: "👍",
		});
	});

	/**
	 * RER05: Messages carrying the discordMessageOrigin extension are skipped,
	 * preventing Discord → Roomy → Discord echo.
	 */
	test("RER05: skips messages with discordMessageOrigin extension", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const event = makeCreateMessageEvent({
			origin: {
				snowflake: "999999999999999999",
				channelId: DISCORD_CHANNEL_ID,
				guildId: GUILD,
			},
		});
		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(0);
	});

	/**
	 * RER06: Messages that are already mapped (e.g. from a previous backfill) are
	 * skipped, preventing duplicates on restart.
	 */
	test("RER06: skips already-mapped messages", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			"already-bridged",
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const event = makeCreateMessageEvent({ id: ROOMY_MESSAGE_ULID });
		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(0);
	});

	/**
	 * RER07: Messages in a Roomy room that has no Discord channel/thread mapping
	 * are silently skipped.
	 */
	test("RER07: skips messages in unbridged rooms", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const event = makeCreateMessageEvent({
			room: newUlid(), // not mapped to a Discord channel
		});
		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(0);
	});

	/**
	 * RER08: A Roomy message with no authorOverride uses the default webhook
	 * name and no avatar.
	 */
	test("RER08: falls back to default name when authorOverride is absent", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const event = makeCreateMessageEvent({ content: "No author override" });
		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(1);
		const sent = discord.sent[0];
		expect(sent?.options?.username).toBe("Roomy");
		expect(sent?.options?.avatarUrl).toBeUndefined();
	});

	/**
	 * RER09: editMessage events with a text/x-dmp-patch body are skipped instead
	 * of sending blank content to Discord.
	 */
	test("RER09: skips editMessage with text/x-dmp-patch body", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const patchEvent = {
			id: newUlid(),
			room: ROOMY_CHANNEL_ULID,
			$type: "space.roomy.message.editMessage.v0" as const,
			messageId: ROOMY_MESSAGE_ULID,
			body: {
				mimeType: "text/x-dmp-patch",
				data: toBytes(new TextEncoder().encode("@@ fake patch")),
			},
			extensions: {},
		} satisfies Event;
		await roomy.fireEvent(SPACE_A, patchEvent);

		expect(discord.edited).toHaveLength(0);
	});

	/**
	 * RER35: editMessage with a rich text (blocks+facets) body is decoded and
	 * bridged to Discord as rendered Discord markdown — the same path the
	 * app-lite composer uses when editing a richtext message.
	 */
	test("RER35: bridges a rich text editMessage to Discord", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const blocks = [
			{ $type: "space.roomy.richtext.blocks#text", text: "Edited from blocks" },
			{ $type: "space.roomy.richtext.blocks#code", text: "const y = 2;" },
		];
		const body = serializeBlocks(blocks);
		const editEvent = {
			id: newUlid(),
			room: ROOMY_CHANNEL_ULID,
			$type: "space.roomy.message.editMessage.v0" as const,
			messageId: ROOMY_MESSAGE_ULID,
			body: { mimeType: body.mimeType, data: toBytes(body.data) },
			extensions: {},
		} satisfies Event;
		await roomy.fireEvent(SPACE_A, editEvent);

		expect(discord.edited).toHaveLength(1);
		expect(discord.edited[0]).toEqual({
			channelId: DISCORD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
			content: "Edited from blocks\n```\nconst y = 2;\n```",
		});
	});

	/**
	 * RER36: editMessage for a message in a bridged thread resolves the
	 * parent channel's webhook and edits the message in the thread channel:
	 * without the parent-channel webhook the edit would target the wrong
	 * webhook and Discord would 404.
	 */
	test("RER36: bridges editMessage in a thread via the parent webhook", async () => {
		const { roomy, discord, router, repo } = setup();
		const THREAD_CHANNEL_ID = "900000000000000001";
		repo.registerMapping(
			SPACE_A,
			"thread",
			THREAD_CHANNEL_ID,
			ROOMY_THREAD_ULID,
		);
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		discord.setParentChannelId(THREAD_CHANNEL_ID, DISCORD_CHANNEL_ID);
		await router.subscribeToSpace(SPACE_A);

		const editEvent = {
			id: newUlid(),
			room: ROOMY_THREAD_ULID,
			$type: "space.roomy.message.editMessage.v0" as const,
			messageId: ROOMY_MESSAGE_ULID,
			body: makeTextBody("Edited in thread"),
			extensions: {},
		} satisfies Event;
		await roomy.fireEvent(SPACE_A, editEvent);

		expect(discord.edited).toHaveLength(1);
		expect(discord.edited[0]).toEqual({
			channelId: THREAD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
			content: "Edited in thread",
		});
	});

	/**
	 * RER10: The router can subscribe to a brand-new space at runtime without
	 * re-running start().
	 */
	test("RER10: subscribeToSpace wires up a new space", async () => {
		const repo = BridgeRepository.open(":memory:");
		repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
		const roomyRoomB = newUlid();
		repo.registerMapping(SPACE_B, "channel", DISCORD_CHANNEL_ID, roomyRoomB);

		const roomy = new MockRoomyGateway();
		const discord = new FileDiscordSender();
		const webhooks = new FileWebhookManager();
		const profiles = new FileProfileResolver();
		const router = new RoomyEventRouter(
			roomy,
			discord,
			webhooks,
			profiles,
			repo,
		);

		await router.subscribeToSpace(SPACE_B);
		await roomy.fireEvent(
			SPACE_B,
			makeCreateMessageEvent({ room: roomyRoomB, content: "space B message" }),
		);

		expect(discord.sent).toHaveLength(1);
		expect(discord.sent[0]?.content).toBe("space B message");
	});

	/**
	 * RER11: A Roomy thread created via createRoom + isCreationLink is mirrored
	 * to Discord as a thread in the parent channel.
	 */
	test("RER11: creates Discord thread for Roomy thread creation", async () => {
		const { roomy, discord, router, repo } = setup();
		await router.subscribeToSpace(SPACE_A);

		const threadId = newUlid();
		await roomy.fireEvent(SPACE_A, makeCreateThreadEvent({ id: threadId }));

		// createRoom alone does not create a Discord thread.
		expect(discord.threads).toHaveLength(0);

		await roomy.fireEvent(
			SPACE_A,
			makeCreateRoomLinkEvent({
				room: ROOMY_CHANNEL_ULID,
				linkToRoom: threadId,
				isCreationLink: true,
			}),
		);

		expect(discord.threads).toHaveLength(1);
		const thread = discord.threads[0];
		expect(thread?.channelId).toBe(DISCORD_CHANNEL_ID);
		expect(thread?.name).toBe("Test Thread");
		expect(thread?.isPrivate).toBe(false);

		// Mapping registered so messages in this thread get bridged
		const mappedDiscordThreadId = repo.getDiscordId(
			SPACE_A,
			"thread",
			threadId,
		);
		expect(mappedDiscordThreadId).toBe(thread?.id);
	});

	/**
	 * RER12: Threads that originated from Discord are not mirrored back.
	 */
	test("RER12: skips Discord-originated threads", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const threadId = newUlid();
		await roomy.fireEvent(
			SPACE_A,
			makeCreateThreadEvent({
				id: threadId,
				origin: {
					snowflake: "999999999999999999",
					channelId: DISCORD_CHANNEL_ID,
					guildId: GUILD,
				},
			}),
		);
		await roomy.fireEvent(
			SPACE_A,
			makeCreateRoomLinkEvent({
				room: ROOMY_CHANNEL_ULID,
				linkToRoom: threadId,
				isCreationLink: true,
			}),
		);

		expect(discord.threads).toHaveLength(0);
	});

	/**
	 * RER13: A non-creation createRoomLink does not create a Discord thread.
	 */
	test("RER13: ignores non-creation room links", async () => {
		const { roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);

		const threadId = newUlid();
		await roomy.fireEvent(SPACE_A, makeCreateThreadEvent({ id: threadId }));
		await roomy.fireEvent(
			SPACE_A,
			makeCreateRoomLinkEvent({
				room: ROOMY_CHANNEL_ULID,
				linkToRoom: threadId,
				isCreationLink: false,
			}),
		);

		expect(discord.threads).toHaveLength(0);
	});

	/**
	 * RER14: forwardMessages forwards a mapped message to a bridged Discord
	 * channel/thread.
	 */
	test("RER14: bridges forwardMessages to Discord as a faux forward via webhook", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const forwardEvent = makeForwardMessagesEvent({});
		await roomy.fireEvent(SPACE_A, forwardEvent, false, DISCORD_USER_DID);

		expect(discord.sent).toHaveLength(1);
		const sent = discord.sent[0];
		expect(sent?.channelId).toBe(DISCORD_CHANNEL_ID);
		expect(sent?.content).toBe(
			`-# ↪ Forwarded from https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${DISCORD_MESSAGE_ID} by Original Author\noriginal content`,
		);
		// The webhook is attributed to the user who did the forward.
		expect(sent?.options?.username).toBe("Bridged User - @bridged.bsky.social");
		expect(sent?.options?.avatarUrl).toBe("https://example.com/avatar.png");

		// Mapping registered so Discord→Roomy dedup catches the echo
		const mappedDiscordId = repo.getDiscordId(
			SPACE_A,
			"message",
			`${forwardEvent.id}:${ROOMY_MESSAGE_ULID}`,
		);
		expect(mappedDiscordId).toBe(sent?.messageId);
	});

	/**
	 * RER15: forwardMessages is skipped when the destination room is not bridged.
	 */
	test("RER15: skips forwardMessages for unbridged destination", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(
			SPACE_A,
			makeForwardMessagesEvent({ room: newUlid() }),
		);

		expect(discord.sent).toHaveLength(0);
	});

	/**
	 * RER16: forwardMessages is skipped when the source room is not bridged.
	 */
	test("RER16: skips forwardMessages for unbridged source", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(
			SPACE_A,
			makeForwardMessagesEvent({ fromRoomId: newUlid() }),
		);

		expect(discord.sent).toHaveLength(0);
	});

	/**
	 * RER17: Already-bridged forward events are skipped to prevent duplicates.
	 */
	test("RER17: skips already-mapped forwardMessages", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		const forwardId = newUlid();
		repo.registerMapping(
			SPACE_A,
			"message",
			"already-forwarded",
			`${forwardId}:${ROOMY_MESSAGE_ULID}`,
		);
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(SPACE_A, makeForwardMessagesEvent({ id: forwardId }));

		expect(discord.sent).toHaveLength(0);
	});

	/**
	 * RER18: forwardMessages can forward to a Roomy thread that is mapped to
	 * a Discord thread.
	 */
	test("RER18: forwards messages to a mapped Discord thread", async () => {
		const { roomy, discord, router, repo } = setup();
		const roomyThreadId = newUlid();
		const discordThreadId = "900000000000000001";
		repo.registerMapping(SPACE_A, "thread", discordThreadId, roomyThreadId);
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		discord.setParentChannelId(discordThreadId, DISCORD_CHANNEL_ID);
		discord.setGuildId(discordThreadId, GUILD);
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(
			SPACE_A,
			makeForwardMessagesEvent({ room: roomyThreadId }),
		);

		expect(discord.sent).toHaveLength(1);
		expect(discord.sent[0]?.channelId).toBe(discordThreadId);
		expect(discord.sent[0]?.options?.threadId).toBe(discordThreadId);
	});

	/**
	 * RER19: A forward event that originated from Discord (ingestion stores a
	 * composite mapping) is not re-bridged back to Discord.
	 */
	test("RER19: dedupes Discord-originated forwardMessages", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const forwardEvent = makeForwardMessagesEvent({});
		// Simulate the mapping created by Discord→Roomy ingestion, which uses
		// a composite roomy id of `${forwardEvent.id}:${originalMessageId}`.
		repo.registerMapping(
			SPACE_A,
			"message",
			"discord-forwarded-msg",
			`${forwardEvent.id}:${ROOMY_MESSAGE_ULID}`,
		);

		await roomy.fireEvent(SPACE_A, forwardEvent);

		expect(discord.sent).toHaveLength(0);
	});

	/**
	 * RER20: A pending thread creation survives a process restart: a new router
	 * instance backed by the same repository can still create the Discord thread
	 * when the creation link arrives.
	 */
	test("RER20: pending thread creation survives restart", async () => {
		const { roomy, discord, router, repo } = setup();
		await router.subscribeToSpace(SPACE_A);

		const threadId = newUlid();
		await roomy.fireEvent(SPACE_A, makeCreateThreadEvent({ id: threadId }));

		// Simulate restart by constructing a new router backed by the same repo.
		await roomy.unsubscribe(SPACE_A);
		const freshRouter = new RoomyEventRouter(
			roomy,
			discord,
			new FileWebhookManager(),
			new FileProfileResolver(),
			repo,
		);
		await freshRouter.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(
			SPACE_A,
			makeCreateRoomLinkEvent({
				room: ROOMY_CHANNEL_ULID,
				linkToRoom: threadId,
				isCreationLink: true,
			}),
		);

		expect(discord.threads).toHaveLength(1);
	});

	/**
	 * RER21: moveMessages forwards a mapped message to a bridged Discord
	 * channel/thread, without deleting the original.
	 */
	test("RER21: bridges moveMessages to Discord without deleting original", async () => {
		const { roomy, discord, router, repo } = setup();
		const destRoomId = newUlid();
		const destChannelId = "910000000000000001";
		repo.registerMapping(SPACE_A, "channel", destChannelId, destRoomId);
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		discord.setGuildId(destChannelId, GUILD);
		await router.subscribeToSpace(SPACE_A);

		const moveEvent = makeMoveMessagesEvent({ toRoomId: destRoomId });
		await roomy.fireEvent(SPACE_A, moveEvent, false, DISCORD_USER_DID);

		expect(discord.sent).toHaveLength(1);
		const sent = discord.sent[0];
		expect(sent?.channelId).toBe(destChannelId);
		expect(sent?.content).toBe(
			`-# ↪ Forwarded from https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${DISCORD_MESSAGE_ID} by Original Author\noriginal content`,
		);
		expect(sent?.options?.username).toBe("Bridged User - @bridged.bsky.social");

		// Original Discord message is NOT deleted
		expect(discord.deleted).toHaveLength(0);

		// Mapping registered so Discord→Roomy dedup catches the echo
		const mappedDiscordId = repo.getDiscordId(
			SPACE_A,
			"message",
			`${moveEvent.id}:${ROOMY_MESSAGE_ULID}`,
		);
		expect(mappedDiscordId).toBe(sent?.messageId);
	});

	/**
	 * RER22: moveMessages is skipped when the source room is not bridged.
	 */
	test("RER22: skips moveMessages for unbridged source room", async () => {
		const { roomy, discord, router, repo } = setup();
		const destRoomId = newUlid();
		const destChannelId = "910000000000000001";
		repo.registerMapping(SPACE_A, "channel", destChannelId, destRoomId);
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		// Source room (event.room) is not bridged
		await roomy.fireEvent(
			SPACE_A,
			makeMoveMessagesEvent({ room: newUlid(), toRoomId: destRoomId }),
		);

		expect(discord.sent).toHaveLength(0);
		expect(discord.deleted).toHaveLength(0);
	});

	/**
	 * RER23: moveMessages is skipped when the destination room is not bridged.
	 */
	test("RER23: skips moveMessages for unbridged destination room", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		// Destination room (toRoomId) is not bridged
		await roomy.fireEvent(
			SPACE_A,
			makeMoveMessagesEvent({ toRoomId: newUlid() }),
		);

		expect(discord.sent).toHaveLength(0);
		expect(discord.deleted).toHaveLength(0);
	});

	/**
	 * RER24: Already-bridged move events are skipped to prevent duplicates.
	 */
	test("RER24: skips already-mapped moveMessages", async () => {
		const { roomy, discord, router, repo } = setup();
		const destRoomId = newUlid();
		const destChannelId = "910000000000000001";
		repo.registerMapping(SPACE_A, "channel", destChannelId, destRoomId);
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		const moveId = newUlid();
		repo.registerMapping(
			SPACE_A,
			"message",
			"already-moved",
			`${moveId}:${ROOMY_MESSAGE_ULID}`,
		);
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(
			SPACE_A,
			makeMoveMessagesEvent({ id: moveId, toRoomId: destRoomId }),
		);

		expect(discord.sent).toHaveLength(0);
		expect(discord.deleted).toHaveLength(0);
	});

	/**
	 * RER25: moveMessages can move to a Roomy thread that is mapped to
	 * a Discord thread.
	 */
	test("RER25: moves messages to a mapped Discord thread", async () => {
		const { roomy, discord, router, repo } = setup();
		const destRoomId = newUlid();
		const destThreadId = "920000000000000001";
		repo.registerMapping(SPACE_A, "thread", destThreadId, destRoomId);
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		discord.setParentChannelId(destThreadId, DISCORD_CHANNEL_ID);
		discord.setGuildId(destThreadId, GUILD);
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(
			SPACE_A,
			makeMoveMessagesEvent({ toRoomId: destRoomId }),
		);

		expect(discord.sent).toHaveLength(1);
		expect(discord.sent[0]?.channelId).toBe(destThreadId);
		expect(discord.sent[0]?.options?.threadId).toBe(destThreadId);
		expect(discord.deleted).toHaveLength(0);
	});

	/**
	 * RER26: A move event that originated from Discord (ingestion stores a
	 * composite mapping) is not re-bridged back to Discord.
	 */
	test("RER26: dedupes Discord-originated moveMessages", async () => {
		const { roomy, discord, router, repo } = setup();
		const destRoomId = newUlid();
		const destChannelId = "910000000000000001";
		repo.registerMapping(SPACE_A, "channel", destChannelId, destRoomId);
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const moveEvent = makeMoveMessagesEvent({ toRoomId: destRoomId });
		// Simulate the mapping created by Discord→Roomy ingestion
		repo.registerMapping(
			SPACE_A,
			"message",
			"discord-moved-msg",
			`${moveEvent.id}:${ROOMY_MESSAGE_ULID}`,
		);

		await roomy.fireEvent(SPACE_A, moveEvent);

		expect(discord.sent).toHaveLength(0);
		expect(discord.deleted).toHaveLength(0);
	});

	/**
	 * RER27: moveMessages skips messages that are not bridged to Discord.
	 */
	test("RER27: skips moveMessages for unbridged messages", async () => {
		const { roomy, discord, router, repo } = setup();
		const destRoomId = newUlid();
		const destChannelId = "910000000000000001";
		repo.registerMapping(SPACE_A, "channel", destChannelId, destRoomId);
		await router.subscribeToSpace(SPACE_A);

		// ROOMY_MESSAGE_ULID is not registered as a bridged message
		await roomy.fireEvent(
			SPACE_A,
			makeMoveMessagesEvent({ toRoomId: destRoomId }),
		);

		expect(discord.sent).toHaveLength(0);
		expect(discord.deleted).toHaveLength(0);
	});
});

/**
 * RER29: A Roomy message that carries a reply attachment is bridged to
 * Discord as a reply (via webhook message_reference), not a fresh message.
 */
test("RER29: carries a Roomy reply through to Discord as a reply", async () => {
	const { roomy, discord, router, repo } = setup();
	// The message being replied to was bridged to Discord earlier.
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "This is a reply",
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.reply.v0",
						target: ROOMY_MESSAGE_ULID,
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	const sent = discord.sent[0];
	// Faux reply: a small grey "↪ <link> <snippet>" prefix above the content,
	// sent via webhook (keeping the author's custom attribution).
	expect(sent?.content).toBe(
		`-# ↪ https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${DISCORD_MESSAGE_ID} original content\nThis is a reply`,
	);
	// Sent via webhook (not the bot) so attribution is preserved.
	expect(sent?.options?.webhook).toBeDefined();
});

/**
 * RER30: A Roomy message with media attachments is bridged to Discord with
 * the attachment bytes uploaded as files.
 */
test("RER30: bridges Roomy media attachments to Discord as files", async () => {
	const { roomy, discord, router } = setup();
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "See these",
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.image.v0",
						uri: "https://cdn.example.com/a.png",
						mimeType: "image/png",
					},
					{
						$type: "space.roomy.attachment.file.v0",
						uri: "https://cdn.example.com/doc.pdf",
						mimeType: "application/pdf",
						name: "doc.pdf",
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	const files = discord.sent[0]?.options?.files;
	expect(files).toBeDefined();
	expect(files?.length).toBe(2);
	expect(files?.[0]?.filename).toBe("a.png");
	expect(files?.[0]?.contentType).toBe("image/png");
	expect(files?.[1]?.filename).toBe("doc.pdf");
	expect(files?.[1]?.contentType).toBe("application/pdf");
});

/**
 * RER31: A media-only Roomy message (empty content, attachments present) is
 * bridged to Discord rather than skipped as an empty message.
 */
test("RER31: bridges a media-only Roomy message to Discord", async () => {
	const { roomy, discord, router } = setup();
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "",
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.image.v0",
						uri: "https://cdn.example.com/b.png",
						mimeType: "image/png",
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	expect(discord.sent[0]?.options?.files?.length).toBe(1);
});

/**
 * RER32: A Roomy reply to a message that was never bridged to Discord falls
 * back to a plain (non-reply) Discord message.
 */
test("RER32: falls back to a plain message when reply target is not bridged", async () => {
	const { roomy, discord, router } = setup();
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "Replying to nothing bridged",
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.reply.v0",
						target: newUlid(), // never bridged to Discord
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	// No bridged reply target → no faux reply prefix; plain message sent.
	expect(discord.sent).toHaveLength(1);
	expect(discord.sent[0]?.content).toBe("Replying to nothing bridged");
});

/**
 * RER37: A modern forward — a createMessage carrying a
 * `space.roomy.attachment.forward.v0` embed with an empty body — is bridged
 * to Discord as a faux forward: `forward.v0` is recognised by
 * #extractAttachments, and a bare forward renders the forward block.
 */
test("RER37: bridges a bare forward attachment as a faux forward via webhook", async () => {
	const { roomy, discord, router, repo } = setup();
	// The forwarded original was bridged to Discord earlier. Its source room
	// (ROOMY_CHANNEL_ULID) is bridged to DISCORD_CHANNEL_ID in setup().
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "", // bare forward — no commentary
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.forward.v0",
						target: ROOMY_MESSAGE_ULID,
						fromRoomId: ROOMY_CHANNEL_ULID,
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	const sent = discord.sent[0];
	// Faux forward: the same grey "Forwarded from <link> by <author>" block
	// (with the original's content) the legacy forwardMessages path produces.
	expect(sent?.content).toBe(
		`-# ↪ Forwarded from https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${DISCORD_MESSAGE_ID} by Original Author\noriginal content`,
	);
	// Sent via webhook (not the bot) so the original author's identity holds.
	expect(sent?.options?.webhook).toBeDefined();
});

/**
 * RER38: A modern forward with commentary keeps the commentary AND renders
 * the forward block below it — the commentary is not dropped.
 */
test("RER38: bridges a forward with commentary as commentary plus faux forward", async () => {
	const { roomy, discord, router, repo } = setup();
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "Look at what they said",
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.forward.v0",
						target: ROOMY_MESSAGE_ULID,
						fromRoomId: ROOMY_CHANNEL_ULID,
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	expect(discord.sent[0]?.content).toBe(
		`Look at what they said\n-# ↪ Forwarded from https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${DISCORD_MESSAGE_ID} by Original Author\noriginal content`,
	);
});

/**
 * RER39: a reply.v0 and a forward.v0 on one message coexist — the faux reply
 * prefix, the commentary, and the faux forward block all render.
 */
test("RER39: a reply and a forward on one message render both blocks", async () => {
	const { roomy, discord, router, repo } = setup();
	// Reply target: ROOMY_MESSAGE_ULID, bridged as DISCORD_MESSAGE_ID.
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	// Forward target: a different message, bridged to a second snowflake.
	const forwardedRoomyId = newUlid();
	const forwardedDiscordId = "810000000000000001";
	repo.registerMapping(
		SPACE_A,
		"message",
		forwardedDiscordId,
		forwardedRoomyId,
	);
	discord.setMessage(
		DISCORD_CHANNEL_ID,
		forwardedDiscordId,
		"forwarded content",
	);
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "Replying with a forward",
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.reply.v0",
						target: ROOMY_MESSAGE_ULID,
					},
					{
						$type: "space.roomy.attachment.forward.v0",
						target: forwardedRoomyId,
						fromRoomId: ROOMY_CHANNEL_ULID,
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	expect(discord.sent[0]?.content).toBe(
		`-# ↪ https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${DISCORD_MESSAGE_ID} original content\nReplying with a forward\n-# ↪ Forwarded from https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${forwardedDiscordId} by Original Author\nforwarded content`,
	);
});

/**
 * RER40: A Roomy reply to a parent that was itself bridged to Discord as a
 * faux reply quotes the DIRECT parent's own text — the grandparent link from
 * the parent's `-# ↪` prefix line must not leak into the snippet: the snippet
 * is the parent's own text, not a raw slice whose leading marker line would
 * consume the whole window and truncate mid-snowflake.
 */
test("RER40: reply snippet is the direct parent's own text, not its inherited faux prefix", async () => {
	const { roomy, discord, router, repo } = setup();
	// The parent was bridged to Discord as a faux reply to a grandparent, so
	// its Discord content begins with the bridge's own `-# ↪` marker line.
	const parentRoomyId = newUlid();
	const parentDiscordId = "840000000000000001";
	const grandparentSnowflake = "850000000000000001";
	const parentOwnText =
		"The direct parent's very own message text here, long enough to need a quote ellipsis";
	repo.registerMapping(SPACE_A, "message", parentDiscordId, parentRoomyId);
	discord.setMessage(
		DISCORD_CHANNEL_ID,
		parentDiscordId,
		`-# ↪ https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${grandparentSnowflake} the grandparent's own words\n${parentOwnText}`,
	);
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "This is a reply to the parent",
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.reply.v0",
						target: parentRoomyId,
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	const sent = discord.sent[0];
	// Snippet = first 50 chars of the parent's OWN text, then an ellipsis.
	expect(sent?.content).toBe(
		`-# ↪ https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${parentDiscordId} ${parentOwnText.slice(0, 50)}...\nThis is a reply to the parent`,
	);
	// The grandparent's snowflake must not appear anywhere in the payload.
	expect(sent?.content).not.toContain(grandparentSnowflake);
});

/**
 * RER41: A faux forward of an original that was itself bridged to Discord as
 * a faux reply shows the original's own text as the forwarded body — the
 * original's `-# ↪` marker line is stripped, not duplicated under the
 * "Forwarded from" block.
 */
test("RER41: forward body is the original's own text, not its inherited faux prefix", async () => {
	const { roomy, discord, router, repo } = setup();
	const originalRoomyId = newUlid();
	const originalDiscordId = "860000000000000001";
	const grandparentSnowflake = "870000000000000001";
	const originalOwnText = "The original message's very own forwarded text";
	repo.registerMapping(SPACE_A, "message", originalDiscordId, originalRoomyId);
	discord.setMessage(
		DISCORD_CHANNEL_ID,
		originalDiscordId,
		`-# ↪ https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${grandparentSnowflake} a snippet of the grandparent\n${originalOwnText}`,
	);
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "", // bare forward — no commentary
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.forward.v0",
						target: originalRoomyId,
						fromRoomId: ROOMY_CHANNEL_ULID,
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	expect(discord.sent[0]?.content).toBe(
		`-# ↪ Forwarded from https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${originalDiscordId} by Original Author\n${originalOwnText}`,
	);
	expect(discord.sent[0]?.content).not.toContain(grandparentSnowflake);
});

/**
 * RER42: When a reply's parent has no own text after stripping its faux
 * prefix line (e.g. a forward whose original was deleted, bridged as
 * `-# ↪ Forwarded from …` with an empty body), the faux reply falls back to
 * a link-only prefix — no marker residue.
 */
test("RER42: reply to a marker-only parent falls back to a link-only prefix", async () => {
	const { roomy, discord, router, repo } = setup();
	const parentRoomyId = newUlid();
	const parentDiscordId = "880000000000000001";
	repo.registerMapping(SPACE_A, "message", parentDiscordId, parentRoomyId);
	discord.setMessage(
		DISCORD_CHANNEL_ID,
		parentDiscordId,
		`-# ↪ Forwarded from https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/890000000000000001 by Someone\n`,
	);
	await router.subscribeToSpace(SPACE_A);

	const event = makeCreateMessageEvent({
		content: "Replying to a marker-only parent",
		extensions: {
			"space.roomy.extension.attachments.v0": {
				$type: "space.roomy.extension.attachments.v0",
				attachments: [
					{
						$type: "space.roomy.attachment.reply.v0",
						target: parentRoomyId,
					},
				],
			},
		},
	});
	await roomy.fireEvent(SPACE_A, event);

	expect(discord.sent).toHaveLength(1);
	expect(discord.sent[0]?.content).toBe(
		`-# ↪ https://discord.com/channels/${GUILD}/${DISCORD_CHANNEL_ID}/${parentDiscordId}\nReplying to a marker-only parent`,
	);
});

/**
 * RER43: deleting a message inside a bridged thread deletes it in the thread
 * while resolving the webhook from the parent channel — threads can't have
 * their own webhooks.
 */
test("RER43: deletes a thread message via the parent channel's webhook", async () => {
	const { roomy, discord, router, repo } = setup();
	repo.registerMapping(SPACE_A, "thread", DISCORD_THREAD_ID, ROOMY_THREAD_ULID);
	discord.setParentChannelId(DISCORD_THREAD_ID, DISCORD_CHANNEL_ID);
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	discord.setMessage(
		DISCORD_THREAD_ID,
		DISCORD_MESSAGE_ID,
		"in a thread",
		`wh_${DISCORD_CHANNEL_ID}`,
	);
	await router.subscribeToSpace(SPACE_A);

	await roomy.fireEvent(
		SPACE_A,
		makeDeleteMessageEvent({ room: ROOMY_THREAD_ULID }),
	);

	expect(discord.deleted).toEqual([
		{
			channelId: DISCORD_THREAD_ID,
			messageId: DISCORD_MESSAGE_ID,
			webhook: {
				id: `wh_${DISCORD_CHANNEL_ID}`,
				token: `tok_${DISCORD_CHANNEL_ID}`,
			},
		},
	]);
	expect(
		repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID),
	).toBeUndefined();
});

/**
 * RER44: a thread whose parent channel is unknown has no webhook to delete
 * through, so the delete is skipped and the mapping kept.
 */
test("RER44: skips the delete when the thread's parent channel is unknown", async () => {
	const { roomy, discord, router, repo } = setup();
	const orphanThread = newUlid();
	repo.registerMapping(SPACE_A, "thread", DISCORD_THREAD_ID, orphanThread);
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	discord.setMessage(
		DISCORD_THREAD_ID,
		DISCORD_MESSAGE_ID,
		"in a thread",
		`wh_${DISCORD_CHANNEL_ID}`,
	);
	await router.subscribeToSpace(SPACE_A);

	await roomy.fireEvent(
		SPACE_A,
		makeDeleteMessageEvent({ room: orphanThread }),
	);

	expect(discord.deleted).toHaveLength(0);
	expect(repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID)).toBe(
		DISCORD_MESSAGE_ID,
	);
});

/**
 * RER45: a message a Discord user authored belongs to no webhook, so its
 * delete goes through the bot, not the webhook's endpoint.
 */
test("RER45: deletes a Discord-authored message through the bot", async () => {
	const { roomy, discord, router, repo } = setup();
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	// No webhook id: a Discord user sent it.
	discord.setMessage(DISCORD_CHANNEL_ID, DISCORD_MESSAGE_ID, "user message");
	await router.subscribeToSpace(SPACE_A);

	await roomy.fireEvent(SPACE_A, makeDeleteMessageEvent({}));

	expect(discord.deleted).toEqual([
		{
			channelId: DISCORD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
			webhook: undefined,
		},
	]);
	expect(
		repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID),
	).toBeUndefined();
});

/**
 * RER46: when the bot lacks Manage Messages for a user's message, the Roomy
 * delete is left unmirrored — mapping kept, event not failed.
 */
test("RER46: keeps the mapping when the bot can't delete a user's message", async () => {
	const { roomy, discord, router, repo } = setup();
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	discord.setMessage(DISCORD_CHANNEL_ID, DISCORD_MESSAGE_ID, "user message");
	discord.setBotDeleteError("Missing Permissions");
	await router.subscribeToSpace(SPACE_A);

	await roomy.fireEvent(SPACE_A, makeDeleteMessageEvent({}));

	expect(discord.deleted).toHaveLength(0);
	expect(repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID)).toBe(
		DISCORD_MESSAGE_ID,
	);
});

/**
 * RER47: a bridged message already gone from Discord is skipped — nothing to
 * delete, mapping kept.
 */
test("RER47: skips the delete when the Discord message is gone", async () => {
	const { roomy, discord, router, repo } = setup();
	repo.registerMapping(
		SPACE_A,
		"message",
		"810000000000000009",
		ROOMY_MESSAGE_ULID,
	);
	await router.subscribeToSpace(SPACE_A);

	await roomy.fireEvent(SPACE_A, makeDeleteMessageEvent({}));

	expect(discord.deleted).toHaveLength(0);
	expect(repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID)).toBe(
		"810000000000000009",
	);
});

/**
 * RER48: a delete that originated from Discord must not be mirrored back, or
 * the bridge and Discord would delete each other's copies of a message in a
 * loop.
 */
test("RER48: skips deletes that originated from Discord", async () => {
	const { roomy, discord, router, repo } = setup();
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	discord.setMessage(
		DISCORD_CHANNEL_ID,
		DISCORD_MESSAGE_ID,
		"from Discord",
		`wh_${DISCORD_CHANNEL_ID}`,
	);
	await router.subscribeToSpace(SPACE_A);

	await roomy.fireEvent(
		SPACE_A,
		makeDeleteMessageEvent({
			origin: {
				snowflake: DISCORD_MESSAGE_ID,
				channelId: DISCORD_CHANNEL_ID,
				guildId: GUILD,
			},
		}),
	);

	expect(discord.deleted).toHaveLength(0);
	expect(repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID)).toBe(
		DISCORD_MESSAGE_ID,
	);
});

/**
 * RER49: a Discord user's message inside a thread is deleted through the bot,
 * not the parent channel's webhook — a webhook only authorises the messages it
 * posted itself, so the thread's resolution must not leak into the endpoint
 * choice.
 */
test("RER49: deletes a user's thread message through the bot", async () => {
	const { roomy, discord, router, repo } = setup();
	repo.registerMapping(SPACE_A, "thread", DISCORD_THREAD_ID, ROOMY_THREAD_ULID);
	discord.setParentChannelId(DISCORD_THREAD_ID, DISCORD_CHANNEL_ID);
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	// No webhook id: a Discord user sent it.
	discord.setMessage(DISCORD_THREAD_ID, DISCORD_MESSAGE_ID, "user message");
	await router.subscribeToSpace(SPACE_A);

	await roomy.fireEvent(
		SPACE_A,
		makeDeleteMessageEvent({ room: ROOMY_THREAD_ULID }),
	);

	expect(discord.deleted).toEqual([
		{
			channelId: DISCORD_THREAD_ID,
			messageId: DISCORD_MESSAGE_ID,
			webhook: undefined,
		},
	]);
});

/**
 * RER50: a failed authorship fetch must not be read as "nothing to delete" —
 * the delete still goes through the webhook, so a REST hiccup can't silently
 * drop a Roomy delete.
 */
test("RER50: a failed fetch still deletes via the webhook", async () => {
	const { roomy, discord, router, repo } = setup();
	repo.registerMapping(
		SPACE_A,
		"message",
		DISCORD_MESSAGE_ID,
		ROOMY_MESSAGE_ULID,
	);
	discord.setGetMessageError("Failed to send request to discord.");
	await router.subscribeToSpace(SPACE_A);

	await roomy.fireEvent(SPACE_A, makeDeleteMessageEvent({}));

	expect(discord.deleted).toEqual([
		{
			channelId: DISCORD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
			webhook: {
				id: `wh_${DISCORD_CHANNEL_ID}`,
				token: `tok_${DISCORD_CHANNEL_ID}`,
			},
		},
	]);
	expect(
		repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID),
	).toBeUndefined();
});

describe("resolveAttachmentUrl", () => {
	test("resolves an atblob:// ref to the appserver blob proxy", () => {
		expect(
			resolveAttachmentUrl(
				"atblob://did:plc:abc/cid123",
				"https://api.roomy.space",
			),
		).toBe("https://api.roomy.space/blob/did%3Aplc%3Aabc/cid123");
	});

	test("passes plain HTTP(S) URIs through unchanged", () => {
		expect(
			resolveAttachmentUrl(
				"https://cdn.example.com/a.png",
				"https://api.roomy.space",
			),
		).toBe("https://cdn.example.com/a.png");
	});
});
