/**
 * Unit tests for reaction-sync.ts
 *
 * Covers: RS01–RS09 — reaction add/remove with/without mapping,
 * idempotency, custom emoji parsing, fan-out, subset mode.
 */

import * as bunTest from "bun:test";
import { newUlid, UserDid } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import { reactionKey } from "../../utils/emoji.ts";
import { handleReactionAdd, handleReactionRemove } from "../reaction-sync.ts";
import {
	CHANNEL,
	GUILD,
	ROOMY_CHANNEL_ULID,
	ROOMY_MESSAGE_ULID,
	SPACE_A,
	SPACE_B,
} from "./helpers/test-data.ts";
import { expectToBe, expectToBeDefined } from "./utils.ts";

const EXISTING_EVENT_ULID = newUlid();
const OLD_EVENT_ULID = newUlid();

function reactionAddEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(
		spaceDid,
		"space.roomy.reaction.addBridgedReaction.v0",
	);
}

function reactionRemoveEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(
		spaceDid,
		"space.roomy.reaction.removeBridgedReaction.v0",
	);
}

function setupRepo(): BridgeRepository {
	const repo = BridgeRepository.open(":memory:");
	repo.upsertBridgeConfig(GUILD, SPACE_A, "full");
	repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
	repo.registerMapping(SPACE_A, "message", "5555555555", ROOMY_MESSAGE_ULID);
	return repo;
}

const MESSAGE_ID = BigInt("5555555555");
const CHANNEL_ID = BigInt(CHANNEL);
const USER_ID = BigInt("111111111111111111");
const GUILD_ID = BigInt(GUILD);
const THUMBS_UP = { name: "👍" };

bunTest.describe("handleReactionAdd", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	bunTest.beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// RS01: Reaction add to synced message
	bunTest.test(
		"RS01: sends addBridgedReaction for synced message",
		async () => {
			await handleReactionAdd(
				MESSAGE_ID,
				CHANNEL_ID,
				USER_ID,
				THUMBS_UP,
				GUILD_ID,
				repo,
				roomy,
			);

			const event = reactionAddEvent(roomy, SPACE_A);
			expectToBeDefined(event);
			expectToBe(event.$type, "space.roomy.reaction.addBridgedReaction.v0");
			expectToBe(event.reactionTo, ROOMY_MESSAGE_ULID);
			expectToBe(event.reaction, "👍");
			expectToBe(
				event.reactingUser,
				UserDid.assert(`did:discord:${USER_ID.toString()}`),
			);
		},
	);

	// RS02: Reaction add to unsynced message skipped
	bunTest.test("RS02: skips reaction add when message not synced", async () => {
		await handleReactionAdd(
			BigInt("9999999999"),
			CHANNEL_ID,
			USER_ID,
			THUMBS_UP,
			GUILD_ID,
			repo,
			roomy,
		);

		bunTest.expect(reactionAddEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// RS03: Reaction add duplicate (idempotent)
	bunTest.test(
		"RS03: skips duplicate reaction add when mapping exists",
		async () => {
			const key = reactionKey(MESSAGE_ID, USER_ID, THUMBS_UP);
			repo.registerMapping(SPACE_A, "reaction", key, EXISTING_EVENT_ULID);

			await handleReactionAdd(
				MESSAGE_ID,
				CHANNEL_ID,
				USER_ID,
				THUMBS_UP,
				GUILD_ID,
				repo,
				roomy,
			);

			bunTest.expect(reactionAddEvent(roomy, SPACE_A)).toBeUndefined();
		},
	);

	// RS07: Reaction to channel not in allowlist (subset mode)
	bunTest.test(
		"RS07: skips reaction for channel not in subset allowlist",
		async () => {
			repo.upsertBridgeConfig(GUILD, SPACE_B, "subset");

			await handleReactionAdd(
				MESSAGE_ID,
				CHANNEL_ID,
				USER_ID,
				THUMBS_UP,
				GUILD_ID,
				repo,
				roomy,
			);

			bunTest.expect(reactionAddEvent(roomy, SPACE_A)).toBeDefined();
			bunTest.expect(reactionAddEvent(roomy, SPACE_B)).toBeUndefined();
		},
	);

	// RS08: Reaction fan-out to multiple spaces
	bunTest.test(
		"RS08: fans out reaction to multiple bridged spaces",
		async () => {
			repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
			repo.registerMapping(SPACE_B, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
			repo.registerMapping(
				SPACE_B,
				"message",
				"5555555555",
				ROOMY_MESSAGE_ULID,
			);
			roomy = new MockRoomyGateway();

			await handleReactionAdd(
				MESSAGE_ID,
				CHANNEL_ID,
				USER_ID,
				THUMBS_UP,
				GUILD_ID,
				repo,
				roomy,
			);

			bunTest.expect(reactionAddEvent(roomy, SPACE_A)).toBeDefined();
			bunTest.expect(reactionAddEvent(roomy, SPACE_B)).toBeDefined();
		},
	);

	// RS09: Unicode vs custom emoji correctly parsed
	bunTest.test("RS09a: handles unicode emoji", async () => {
		await handleReactionAdd(
			MESSAGE_ID,
			CHANNEL_ID,
			USER_ID,
			THUMBS_UP,
			GUILD_ID,
			repo,
			roomy,
		);

		const event = reactionAddEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.reaction.addBridgedReaction.v0");
		bunTest.expect(event.reaction).toBe("👍");
	});

	bunTest.test("RS09b: handles custom static emoji", async () => {
		const emoji = { id: BigInt("123456789"), name: "blob" };

		await handleReactionAdd(
			MESSAGE_ID,
			CHANNEL_ID,
			USER_ID,
			emoji,
			GUILD_ID,
			repo,
			roomy,
		);

		const event = reactionAddEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.reaction.addBridgedReaction.v0");
		expectToBe(event.reaction, "<:blob:123456789>");
	});

	bunTest.test("RS09c: handles animated custom emoji", async () => {
		const emoji = { id: BigInt("987654321"), name: "party", animated: true };

		await handleReactionAdd(
			MESSAGE_ID,
			CHANNEL_ID,
			USER_ID,
			emoji,
			GUILD_ID,
			repo,
			roomy,
		);

		const event = reactionAddEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.reaction.addBridgedReaction.v0");
		expectToBe(event.reaction, "<a:party:987654321>");
	});
});

bunTest.describe("handleReactionRemove", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	bunTest.beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// RS04: Reaction remove with mapping
	bunTest.test(
		"RS04: sends removeBridgedReaction and unregisters mapping",
		async () => {
			const key = reactionKey(MESSAGE_ID, USER_ID, THUMBS_UP);
			repo.registerMapping(SPACE_A, "reaction", key, EXISTING_EVENT_ULID);

			await handleReactionRemove(
				MESSAGE_ID,
				CHANNEL_ID,
				USER_ID,
				THUMBS_UP,
				GUILD_ID,
				repo,
				roomy,
			);

			const event = reactionRemoveEvent(roomy, SPACE_A);
			expectToBeDefined(event);
			expectToBe(event.$type, "space.roomy.reaction.removeBridgedReaction.v0");
			expectToBe(event.reactionId, EXISTING_EVENT_ULID);

			// Mapping removed
			bunTest.expect(repo.getRoomyId(SPACE_A, "reaction", key)).toBeUndefined();
		},
	);

	// RS05: Reaction remove without mapping skipped
	bunTest.test(
		"RS05: skips remove when no reaction mapping exists",
		async () => {
			await handleReactionRemove(
				MESSAGE_ID,
				CHANNEL_ID,
				USER_ID,
				THUMBS_UP,
				GUILD_ID,
				repo,
				roomy,
			);

			bunTest.expect(reactionRemoveEvent(roomy, SPACE_A)).toBeUndefined();
		},
	);

	// RS06: Reaction remove then re-add
	bunTest.test("RS06: re-add after remove creates fresh mapping", async () => {
		const key = reactionKey(MESSAGE_ID, USER_ID, THUMBS_UP);
		repo.registerMapping(SPACE_A, "reaction", key, OLD_EVENT_ULID);

		await handleReactionRemove(
			MESSAGE_ID,
			CHANNEL_ID,
			USER_ID,
			THUMBS_UP,
			GUILD_ID,
			repo,
			roomy,
		);

		bunTest.expect(repo.getRoomyId(SPACE_A, "reaction", key)).toBeUndefined();

		await handleReactionAdd(
			MESSAGE_ID,
			CHANNEL_ID,
			USER_ID,
			THUMBS_UP,
			GUILD_ID,
			repo,
			roomy,
		);

		const addEvent = reactionAddEvent(roomy, SPACE_A);
		expectToBeDefined(addEvent);
		bunTest.expect(addEvent.id).not.toBe(OLD_EVENT_ULID);

		const newMapping = repo.getRoomyId(SPACE_A, "reaction", key);
		expectToBeDefined(newMapping);
		expectToBe(newMapping, addEvent.id);
	});
});
