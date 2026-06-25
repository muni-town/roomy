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
import { Did, type Event, newUlid, toBytes, Ulid } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { FileDiscordSender } from "../../discord/file-sender.ts";
import { FileWebhookManager } from "../../discord/file-webhook-manager.ts";
import { FileProfileResolver } from "../../roomy/file-profile-resolver.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import { RoomyEventRouter } from "../roomy-event-router.ts";
import {
	GUILD,
	ROOMY_CHANNEL_ULID,
	ROOMY_MESSAGE_ULID,
	SPACE_A,
	SPACE_B,
	USER_ID,
} from "./helpers/test-data.ts";

const DISCORD_MESSAGE_ID = newUlid();
const DISCORD_CHANNEL_ID = "800000000000000001";
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
	return {
		id,
		room,
		$type: "space.roomy.message.createMessage.v0",
		body: makeTextBody(options.content ?? "Hello from Roomy"),
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
	const webhooks = new FileWebhookManager();
	const profiles = new FileProfileResolver({
		[DISCORD_USER_DID]: {
			name: "Bridged User",
			handle: "bridged.bsky.social",
			avatarUrl: "https://example.com/avatar.png",
		},
	});
	const router = new RoomyEventRouter(roomy, discord, webhooks, profiles, repo);
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
	 * RER02: editMessage updates the previously bridged Discord message.
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
	 * RER03: deleteMessage removes the previously bridged Discord message and
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

		const deleteEvent = {
			id: newUlid(),
			room: ROOMY_CHANNEL_ULID,
			$type: "space.roomy.message.deleteMessage.v0" as const,
			messageId: ROOMY_MESSAGE_ULID,
			extensions: {},
		} satisfies Event;
		await roomy.fireEvent(SPACE_A, deleteEvent);

		expect(discord.deleted).toHaveLength(1);
		expect(discord.deleted[0]).toEqual({
			channelId: DISCORD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
		});
		expect(
			repo.getDiscordId(SPACE_A, "message", ROOMY_MESSAGE_ULID),
		).toBeUndefined();
	});

	/**
	 * RER04: addReaction adds the emoji to the previously bridged Discord message.
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
	test("RER14: bridges forwardMessages to Discord", async () => {
		const { roomy, discord, router, repo } = setup();
		repo.registerMapping(
			SPACE_A,
			"message",
			DISCORD_MESSAGE_ID,
			ROOMY_MESSAGE_ULID,
		);
		await router.subscribeToSpace(SPACE_A);

		const forwardEvent = makeForwardMessagesEvent({});
		await roomy.fireEvent(SPACE_A, forwardEvent);

		expect(discord.forwarded).toHaveLength(1);
		expect(discord.forwarded[0]).toEqual({
			targetChannelId: DISCORD_CHANNEL_ID,
			messageId: DISCORD_MESSAGE_ID,
			sourceChannelId: DISCORD_CHANNEL_ID,
			newMessageId: "1",
		});

		// Mapping registered so Discord→Roomy dedup catches the echo
		const mappedDiscordId = repo.getDiscordId(
			SPACE_A,
			"message",
			`${forwardEvent.id}:${ROOMY_MESSAGE_ULID}`,
		);
		expect(mappedDiscordId).toBe(discord.forwarded[0]?.newMessageId);
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

		expect(discord.forwarded).toHaveLength(0);
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

		expect(discord.forwarded).toHaveLength(0);
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

		expect(discord.forwarded).toHaveLength(0);
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
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(
			SPACE_A,
			makeForwardMessagesEvent({ room: roomyThreadId }),
		);

		expect(discord.forwarded).toHaveLength(1);
		expect(discord.forwarded[0]?.targetChannelId).toBe(discordThreadId);
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

		expect(discord.forwarded).toHaveLength(0);
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
		await router.subscribeToSpace(SPACE_A);

		const moveEvent = makeMoveMessagesEvent({ toRoomId: destRoomId });
		await roomy.fireEvent(SPACE_A, moveEvent);

		expect(discord.forwarded).toHaveLength(1);
		expect(discord.forwarded[0]).toEqual({
			targetChannelId: destChannelId,
			messageId: DISCORD_MESSAGE_ID,
			sourceChannelId: DISCORD_CHANNEL_ID,
			newMessageId: "1",
		});

		// Original Discord message is NOT deleted
		expect(discord.deleted).toHaveLength(0);

		// Mapping registered so Discord→Roomy dedup catches the echo
		const mappedDiscordId = repo.getDiscordId(
			SPACE_A,
			"message",
			`${moveEvent.id}:${ROOMY_MESSAGE_ULID}`,
		);
		expect(mappedDiscordId).toBe(discord.forwarded[0]?.newMessageId);
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

		expect(discord.forwarded).toHaveLength(0);
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

		expect(discord.forwarded).toHaveLength(0);
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

		expect(discord.forwarded).toHaveLength(0);
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
		await router.subscribeToSpace(SPACE_A);

		await roomy.fireEvent(
			SPACE_A,
			makeMoveMessagesEvent({ toRoomId: destRoomId }),
		);

		expect(discord.forwarded).toHaveLength(1);
		expect(discord.forwarded[0]?.targetChannelId).toBe(destThreadId);
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

		expect(discord.forwarded).toHaveLength(0);
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

		expect(discord.forwarded).toHaveLength(0);
		expect(discord.deleted).toHaveLength(0);
	});
});
