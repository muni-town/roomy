/**
 * Unit tests for send-retry.ts
 *
 * Covers: SR01–SR09 — a live send that throws is queued rather than dropped,
 * the sweep re-offers it unchanged, re-queued sends supersede, capacity-halted
 * spaces wait, exhausted entries go terminal and stay counted, and the drop is
 * logged under a stable signature.
 */

import { beforeEach, describe, expect, test, vi } from "bun:test";
import type { Event } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { resetCapacityGate, setCapacityGate } from "../../roomy/capacity.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import {
	handleMessageDelete,
	handleMessageEdit,
} from "../message-edit-delete.ts";
import { ingestDiscordMessage } from "../message-ingestion.ts";
import { retryQueuedSends, SEND_SWEEP_MAX_ATTEMPTS } from "../send-retry.ts";
import {
	CHANNEL,
	GUILD,
	makeMessage,
	ROOMY_CHANNEL_ULID,
	ROOMY_MESSAGE_ULID,
	SPACE_A,
} from "./helpers/test-data.ts";
import { expectToBe, expectToBeDefined } from "./utils.ts";

const MSG_ID = "987654321";
const CREATE_TYPE = "space.roomy.message.createMessage.v0";
const EDIT_TYPE = "space.roomy.message.editMessage.v0";
const DELETE_TYPE = "space.roomy.message.deleteMessage.v0";
/** Past every backoff the sweep can schedule (capped at 30 min). */
const LATER = 60 * 60 * 1000;

/** The create event for SPACE_A, once it has landed. */
function createMessageEvent(roomy: MockRoomyGateway) {
	return roomy.findEvent(SPACE_A, "space.roomy.message.createMessage.v0");
}

/** The event stored in a queue entry's payload. */
function queuedEvent(eventJson: string): Event {
	const parsed: unknown = JSON.parse(eventJson);
	if (!isEventLike(parsed)) {
		throw new Error(`queued entry has no event: ${eventJson}`);
	}
	return parsed;
}

function isEventLike(value: unknown): value is Event {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string"
	);
}

/** Fields of a structured log line; `msg` is absent for non-JSON output. */
function logLine(line: unknown): {
	msg?: string;
	op?: string;
	discordId?: string;
} {
	let fields: Record<string, unknown> = {};
	try {
		fields = JSON.parse(String(line)) ?? {};
	} catch {
		// A non-JSON line carries no structured fields.
	}
	const read = (key: string): string | undefined => {
		const found = fields[key];
		return typeof found === "string" ? found : undefined;
	};
	return { msg: read("msg"), op: read("op"), discordId: read("discordId") };
}

/** The edit event for SPACE_A, once it has landed. */
function editMessageEvent(roomy: MockRoomyGateway) {
	return roomy.findEvent(SPACE_A, "space.roomy.message.editMessage.v0");
}

/** The delete event for SPACE_A, once it has landed. */
function deleteMessageEvent(roomy: MockRoomyGateway) {
	return roomy.findEvent(SPACE_A, "space.roomy.message.deleteMessage.v0");
}

function setupRepo(): BridgeRepository {
	const repo = BridgeRepository.open(":memory:");
	repo.upsertBridgeConfig(GUILD, SPACE_A, "full");
	repo.registerMapping(SPACE_A, "channel", CHANNEL, ROOMY_CHANNEL_ULID);
	return repo;
}

describe("send-retry", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// SR01
	test("SR01: a failed live send is queued, and nothing on the live path re-offers it", async () => {
		roomy.failSends({ $type: CREATE_TYPE });

		const result = await ingestDiscordMessage(
			makeMessage({ id: MSG_ID }),
			repo,
			roomy,
		);

		expect(result.synced).toBe(0);
		expect(createMessageEvent(roomy)).toBeUndefined();
		// The cursor is the backfill watermark and only backfill reads it, so
		// the queued event is the sole record of a live send that threw.
		expect(repo.getChannelCursor(SPACE_A, CHANNEL)).toBeUndefined();

		const queued = repo.listFailedSends();
		expect(queued.length).toBe(1);
		expectToBe(queued[0]?.op, "message_create");
		expectToBe(queued[0]?.discordId, MSG_ID);
		expectToBe(queued[0]?.mappingKind, "message");
		expect(queued[0]?.lastError).toContain("sendEvents timed out");
		expect(repo.countFailedSends()).toEqual({ pending: 1, terminal: 0 });
	});

	// SR02
	test("SR02: the sweep re-offers the queued event unchanged and registers its mapping", async () => {
		roomy.failSends({ $type: CREATE_TYPE, count: 1 });
		await ingestDiscordMessage(makeMessage({ id: MSG_ID }), repo, roomy);

		const queuedRow = repo.listFailedSends()[0];
		expectToBeDefined(queuedRow);
		const queuedId = queuedEvent(queuedRow.eventJson).id;

		await retryQueuedSends(repo, roomy, Date.now() + LATER);

		const sent = createMessageEvent(roomy);
		expectToBeDefined(sent);
		expect(sent.id).toBe(queuedId);
		expect(repo.getRoomyId(SPACE_A, "message", MSG_ID)).toBe(queuedId);
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
	});

	// SR03
	test("SR03: re-queuing the same send supersedes the payload instead of adding a row", async () => {
		roomy.failSends({ $type: CREATE_TYPE });

		await ingestDiscordMessage(
			makeMessage({ id: MSG_ID, content: "first" }),
			repo,
			roomy,
		);
		await ingestDiscordMessage(
			makeMessage({ id: MSG_ID, content: "second" }),
			repo,
			roomy,
		);

		const queued = repo.listFailedSends();
		expect(queued.length).toBe(1);
		expect(queued[0]?.attempts).toBe(2);
	});

	// SR04
	test("SR04: a capacity-halted space waits without spending an attempt", async () => {
		roomy.failSends({ $type: CREATE_TYPE, count: 1 });
		await ingestDiscordMessage(makeMessage({ id: MSG_ID }), repo, roomy);

		setCapacityGate({ isEnabled: async () => false });
		try {
			await retryQueuedSends(repo, roomy, Date.now() + LATER);

			const held = repo.listFailedSends()[0];
			expectToBeDefined(held);
			expect(held.attempts).toBe(1);
			expect(createMessageEvent(roomy)).toBeUndefined();
		} finally {
			resetCapacityGate();
		}

		await retryQueuedSends(repo, roomy, Date.now() + LATER);
		expectToBeDefined(createMessageEvent(roomy));
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
	});

	// SR05
	test("SR05: a send that never lands goes terminal, and the drop stays counted", async () => {
		roomy.failSends({ $type: CREATE_TYPE });
		await ingestDiscordMessage(makeMessage({ id: MSG_ID }), repo, roomy);

		for (let sweep = 0; sweep < SEND_SWEEP_MAX_ATTEMPTS; sweep++) {
			const due = repo.listFailedSends()[0];
			expectToBeDefined(due);
			if (due.terminal) break;
			await retryQueuedSends(repo, roomy, (due.nextRetryAt ?? 0) + 1);
		}

		const abandoned = repo.listFailedSends()[0];
		expectToBeDefined(abandoned);
		expect(abandoned.terminal).toBe(true);
		expect(abandoned.attempts).toBe(SEND_SWEEP_MAX_ATTEMPTS);
		expect(abandoned.nextRetryAt).toBeNull();

		// Terminal entries are never re-offered; the count is the record of
		// what the bridge gave up on.
		const counts = repo.countFailedSends();
		expect(counts).toEqual({ pending: 0, terminal: 1 });
		await retryQueuedSends(repo, roomy, Number.MAX_SAFE_INTEGER);
		expect(createMessageEvent(roomy)).toBeUndefined();
		expect(repo.countFailedSends()).toEqual(counts);
	});

	// SR06
	test("SR06: the drop is one error line under a stable signature", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			roomy.failSends({ $type: CREATE_TYPE });
			await ingestDiscordMessage(makeMessage({ id: MSG_ID }), repo, roomy);

			const lines = () => errorSpy.mock.calls.map((call) => logLine(call[0]));

			const queued = lines().find(
				(line) => line.msg === "Discord→Roomy send failed; queued for re-offer",
			);
			expectToBeDefined(queued);
			// Identifiers ride in fields: a per-id message line would give every
			// drop its own log series and hide a burst.
			expect(queued.msg).not.toContain(MSG_ID);
			expectToBe(queued.discordId, MSG_ID);
			expectToBe(queued.op, "message_create");

			for (let sweep = 0; sweep < SEND_SWEEP_MAX_ATTEMPTS; sweep++) {
				const due = repo.listFailedSends()[0];
				expectToBeDefined(due);
				await retryQueuedSends(repo, roomy, (due.nextRetryAt ?? 0) + 1);
			}

			expectToBeDefined(
				lines().find(
					(line) => line.msg === "Discord→Roomy send abandoned after re-offers",
				),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	// SR07
	test("SR07: a failed edit is queued and re-offered", async () => {
		repo.registerMapping(SPACE_A, "message", MSG_ID, ROOMY_MESSAGE_ULID);
		roomy.failSends({ $type: EDIT_TYPE, count: 1 });

		await handleMessageEdit(
			makeMessage({
				id: MSG_ID,
				content: "edited",
				editedTimestamp: Date.now(),
			}),
			repo,
			roomy,
		);

		const queued = repo.listFailedSends()[0];
		expectToBeDefined(queued);
		expectToBe(queued.op, "message_edit");
		expect(editMessageEvent(roomy)).toBeUndefined();

		await retryQueuedSends(repo, roomy, Date.now() + LATER);

		const sent = editMessageEvent(roomy);
		expectToBeDefined(sent);
		expect(sent.messageId).toBe(ROOMY_MESSAGE_ULID);
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
	});

	// SR08
	test("SR08: a failed delete is queued and re-offered", async () => {
		repo.registerMapping(SPACE_A, "message", MSG_ID, ROOMY_MESSAGE_ULID);
		roomy.failSends({ $type: DELETE_TYPE, count: 1 });

		await handleMessageDelete(
			BigInt(MSG_ID),
			BigInt(CHANNEL),
			BigInt(GUILD),
			repo,
			roomy,
		);

		const queued = repo.listFailedSends()[0];
		expectToBeDefined(queued);
		expectToBe(queued.op, "message_delete");
		expect(deleteMessageEvent(roomy)).toBeUndefined();

		await retryQueuedSends(repo, roomy, Date.now() + LATER);

		const sent = deleteMessageEvent(roomy);
		expectToBeDefined(sent);
		expect(sent.messageId).toBe(ROOMY_MESSAGE_ULID);
	});

	// SR09
	test("SR09: create, edit and delete of one message queue as separate entries", async () => {
		roomy.failSends({ $type: CREATE_TYPE, count: 1 });
		await ingestDiscordMessage(makeMessage({ id: MSG_ID }), repo, roomy);

		// The failed create registered no mapping; the mutation handlers need
		// one to have a target at all.
		repo.registerMapping(SPACE_A, "message", MSG_ID, ROOMY_MESSAGE_ULID);

		roomy.failSends({ $type: EDIT_TYPE, count: 1 });
		await handleMessageEdit(
			makeMessage({
				id: MSG_ID,
				content: "edited",
				editedTimestamp: Date.now(),
			}),
			repo,
			roomy,
		);

		roomy.failSends({ $type: DELETE_TYPE, count: 1 });
		await handleMessageDelete(
			BigInt(MSG_ID),
			BigInt(CHANNEL),
			BigInt(GUILD),
			repo,
			roomy,
		);

		const queued = repo.listFailedSends();
		expect(queued.map((entry) => entry.op).sort()).toEqual([
			"message_create",
			"message_delete",
			"message_edit",
		]);
		expect(repo.countFailedSends()).toEqual({ pending: 3, terminal: 0 });
	});
});
