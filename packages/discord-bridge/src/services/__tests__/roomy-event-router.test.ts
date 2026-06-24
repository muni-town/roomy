/**
 * Unit tests for RoomyEventRouter (Roomy → Discord direction).
 *
 * Covers: RER01–RER09 — message create/edit/delete/reaction, echo prevention,
 * unbridged-room skipping, profile attribution, and x-dmp-patch edit skipping.
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
});
