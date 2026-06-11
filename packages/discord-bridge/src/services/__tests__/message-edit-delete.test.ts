/**
 * Unit tests for message-edit-delete.ts
 *
 * Covers: ED01–ED10 — edit/delete with and without mappings,
 * editedTimestamp gate, mention resolution, profile sync, fan-out.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { BridgeRepository } from "../../db/repository.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import {
	handleMessageDelete,
	handleMessageEdit,
} from "../message-edit-delete.ts";
import {
	CHANNEL,
	GUILD,
	makeMessage,
	makeUser,
	ROOMY_CHANNEL_ULID,
	ROOMY_MESSAGE_ULID,
	SPACE_A,
	SPACE_B,
} from "./helpers/test-data.ts";
import { expectToBe, expectToBeDefined } from "./utils.ts";

/** Extract the editMessage event. */
function editMessageEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.message.editMessage.v0");
}

/** Extract the deleteMessage event. */
function deleteMessageEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.message.deleteMessage.v0");
}

function setupRepo(): BridgeRepository {
	const repo = BridgeRepository.open(":memory:");
	repo.upsertBridgeConfig(GUILD, SPACE_A, "full");
	repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
	return repo;
}

const MSG_ID_STR = "987654321";

describe("handleMessageEdit", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// ED01: Edit with existing mapping
	test("ED01: sends editMessage when mapping exists", async () => {
		repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

		const msg = makeMessage({
			id: MSG_ID_STR,
			content: "Updated content",
			editedTimestamp: String(Date.now()),
		});

		await handleMessageEdit(msg, repo, roomy);

		const event = editMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expectToBe(event.$type, "space.roomy.message.editMessage.v0");
		expectToBe(event.messageId, ROOMY_MESSAGE_ULID);
		const decoded = atob(event.body.data.$bytes);
		expect(decoded).toBe("Updated content");
	});

	// ED02: Edit without editedTimestamp skipped
	test("ED02: skips edit when editedTimestamp is absent", async () => {
		repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

		const msg = makeMessage({
			id: MSG_ID_STR,
			content: "Updated",
			editedTimestamp: null,
		});

		await handleMessageEdit(msg, repo, roomy);
		expect(editMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// ED03: Edit without mapping skipped
	test("ED03: skips edit when no Roomy message mapping exists", async () => {
		const msg = makeMessage({
			id: MSG_ID_STR,
			content: "Updated",
			editedTimestamp: String(Date.now()),
		});

		await handleMessageEdit(msg, repo, roomy);
		expect(editMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// ED04: Edit to unsynced channel skipped
	test("ED04: skips edit for channel without Roomy room mapping", async () => {
		repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

		const msg = makeMessage({
			id: MSG_ID_STR,
			channelId: "999999999999999999",
			content: "Updated",
			editedTimestamp: String(Date.now()),
		});

		await handleMessageEdit(msg, repo, roomy);
		expect(editMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// ED05: Edit with mention resolution
	test("ED05: resolves mentions in edited content", async () => {
		repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

		const msg = makeMessage({
			id: MSG_ID_STR,
			content: "Edited <@111111111111111111>!",
			editedTimestamp: String(Date.now()),
			mentions: [
				makeUser({
					id: "111111111111111111",
					name: "testuser",
					globalName: "Test User",
				}),
			],
		});

		await handleMessageEdit(msg, repo, roomy);

		const event = editMessageEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.message.editMessage.v0");
		const decoded = atob(event.body.data.$bytes);
		expect(decoded).toContain("[@Test User]()");
	});

	// ED10: Edit fan-out to multiple spaces
	test("ED10: fans out edit to multiple bridged spaces", async () => {
		repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
		repo.registerMapping(SPACE_B, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
		repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);
		repo.registerMapping(SPACE_B, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);
		roomy = new MockRoomyGateway();

		const msg = makeMessage({
			id: MSG_ID_STR,
			content: "Fan-out edit",
			editedTimestamp: String(Date.now()),
		});

		await handleMessageEdit(msg, repo, roomy);

		expect(editMessageEvent(roomy, SPACE_A)).toBeDefined();
		expect(editMessageEvent(roomy, SPACE_B)).toBeDefined();
	});
});

describe("handleMessageDelete", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// ED07: Delete with mapping
	test("ED07: sends deleteMessage when mapping exists (mapping preserved)", async () => {
		repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

		await handleMessageDelete(
			BigInt(MSG_ID_STR),
			BigInt(CHANNEL),
			BigInt(GUILD),
			repo,
			roomy,
		);

		const event = deleteMessageEvent(roomy, SPACE_A);
		expectToBeDefined(event);
		expectToBe(event.$type, "space.roomy.message.deleteMessage.v0");
		expectToBe(event.messageId, ROOMY_MESSAGE_ULID);

		// Mapping preserved (not deleted)
		expect(repo.getRoomyId(SPACE_A, "message", MSG_ID_STR)).toBe(
			ROOMY_MESSAGE_ULID,
		);
	});

	// ED08: Delete without mapping skipped
	test("ED08: skips delete when no mapping exists", async () => {
		await handleMessageDelete(
			BigInt(MSG_ID_STR),
			BigInt(CHANNEL),
			BigInt(GUILD),
			repo,
			roomy,
		);

		expect(deleteMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// ED09: Delete from unsynced channel skipped
	test("ED09: skips delete for channel without room mapping", async () => {
		repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);

		await handleMessageDelete(
			BigInt(MSG_ID_STR),
			BigInt("999999999999999999"),
			BigInt(GUILD),
			repo,
			roomy,
		);

		expect(deleteMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// ED10: Delete fan-out to multiple spaces
	test("ED10: fans out delete to multiple bridged spaces", async () => {
		repo.upsertBridgeConfig(GUILD, SPACE_B, "full");
		repo.registerMapping(SPACE_B, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
		repo.registerMapping(SPACE_A, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);
		repo.registerMapping(SPACE_B, "message", MSG_ID_STR, ROOMY_MESSAGE_ULID);
		roomy = new MockRoomyGateway();

		await handleMessageDelete(
			BigInt(MSG_ID_STR),
			BigInt(CHANNEL),
			BigInt(GUILD),
			repo,
			roomy,
		);

		expect(deleteMessageEvent(roomy, SPACE_A)).toBeDefined();
		expect(deleteMessageEvent(roomy, SPACE_B)).toBeDefined();
	});

	test("exits early when guildId is undefined", async () => {
		await handleMessageDelete(
			BigInt(MSG_ID_STR),
			BigInt(CHANNEL),
			undefined,
			repo,
			roomy,
		);

		expect(deleteMessageEvent(roomy, SPACE_A)).toBeUndefined();
	});
});
