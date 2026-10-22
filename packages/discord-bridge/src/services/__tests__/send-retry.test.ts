/**
 * Unit tests for send-retry.ts
 *
 * Covers: SR01–SR13 — a live send that throws is queued rather than dropped,
 * the sweep re-offers it unchanged, re-queued sends supersede, capacity-halted
 * spaces wait, an outage of hours costs one attempt per failed sweep and still
 * lands, exhausted entries go terminal and stay counted, the drop is logged
 * under a stable signature, a replay puts an abandoned entry back through the
 * sweep, and an overlapping sweep is dropped rather than run twice.
 */

import type { Event } from "@roomy-space/sdk";
import { beforeEach, describe, expect, test, vi } from "bun:test";
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
import { expectToBe, expectToBeDefined, queuedEvents } from "./utils.ts";

const MSG_ID = "987654321";
const CREATE_TYPE = "space.roomy.message.createMessage.v0";
const EDIT_TYPE = "space.roomy.message.editMessage.v0";
const DELETE_TYPE = "space.roomy.message.deleteMessage.v0";
/** Past every backoff the sweep can schedule (capped at 30 min). */
const LATER = 60 * 60 * 1000;

/**
 * The body api.roomy.space returns when Cloudflare cannot reach it: not JSON,
 * so the XRPC transport reports it verbatim after the status.
 */
const CLOUDFLARE_502 = `XRPC space.roomy.space.sendEvents failed (502): <!DOCTYPE html>
<html>
  <head><title>api.roomy.space | 502: Bad Gateway</title></head>
  <body>
    <h1>Bad gateway</h1>
    <p>Error 502</p>
  </body>
</html>`;

/** The production sweep tick; the sweep is driven by an advancing clock. */
const SWEEP_TICK_MS = 60 * 1000;

/**
 * An appserver that refuses the message create until the clock reaches
 * `recoverAt`. The sweep's `now` and this clock are the same object, so an
 * outage runs on the schedule's own time and the test never sleeps.
 */
class OutageGateway extends MockRoomyGateway {
	/** Message creates the gateway refused, live and re-offered alike. */
	refused = 0;

	constructor(
		private readonly clock: { now: number },
		private readonly recoverAt: number,
	) {
		super();
	}

	override async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
		if (
			this.clock.now < this.recoverAt &&
			events.some((event) => event.$type === CREATE_TYPE)
		) {
			this.refused++;
			throw new Error(CLOUDFLARE_502);
		}
		await super.sendEvents(spaceDid, events);
	}
}

/** A promise and its resolve, for gating a gateway send from a test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A gateway whose sends hang until `release()`, so two sweeps can overlap. */
class BlockingGateway extends MockRoomyGateway {
	/** Sends that reached the gateway, released or not. */
	sends = 0;
	readonly #gate = deferred();

	release(): void {
		this.#gate.resolve();
	}

	override async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
		this.sends++;
		await this.#gate.promise;
		await super.sendEvents(spaceDid, events);
	}
}

/** The create event for SPACE_A, once it has landed. */
function createMessageEvent(roomy: MockRoomyGateway) {
	return roomy.findEvent(SPACE_A, "space.roomy.message.createMessage.v0");
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
		const queuedEvent = queuedEvents(queuedRow.eventJson)[0];
		expectToBeDefined(queuedEvent);
		const queuedId = queuedEvent.id;
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

	/**
	 * Run an outage of `outageMs` against an appserver that refuses the message
	 * create until it passes, sweeping once per production tick off the test's
	 * clock. Returns the gateway, so a test can read how many attempts it saw.
	 */
	async function runOutage(outageMs: number): Promise<{
		gateway: OutageGateway;
		clock: { now: number };
	}> {
		const clock = { now: Date.now() };
		const gateway = new OutageGateway(clock, clock.now + outageMs);
		await ingestDiscordMessage(makeMessage({ id: MSG_ID }), repo, gateway);
		const end = clock.now + outageMs;
		for (; clock.now < end; clock.now += SWEEP_TICK_MS) {
			await retryQueuedSends(repo, gateway, clock.now);
		}
		return { gateway, clock };
	}

	// SR10
	test("SR10: a three-hour outage costs one attempt per failed sweep, and the message lands when it ends", async () => {
		const { gateway, clock } = await runOutage(3 * 60 * 60 * 1000);

		const queued = repo.listFailedSends()[0];
		expectToBeDefined(queued);
		expect(queued.terminal).toBe(false);
		// One failed delivery, one attempt: the row's count is the number of
		// failures the gateway saw, whichever path recorded them.
		expect(queued.attempts).toBe(gateway.refused);
		// Three hours of refusals cost about eleven attempts — an order of
		// magnitude more than the first waits, far short of the budget.
		expect(queued.attempts).toBeGreaterThanOrEqual(10);
		expect(queued.attempts).toBeLessThan(SEND_SWEEP_MAX_ATTEMPTS);
		expect(repo.countFailedSends()).toEqual({ pending: 1, terminal: 0 });

		// The appserver returns; the entry is delivered by the first sweep after
		// its backoff elapses.
		clock.now = Math.max(clock.now, queued.nextRetryAt ?? clock.now);
		await retryQueuedSends(repo, gateway, clock.now);

		const sent = createMessageEvent(gateway);
		expectToBeDefined(sent);
		expect(repo.getRoomyId(SPACE_A, "message", MSG_ID)).toBe(sent.id);
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
	});

	// SR11
	test("SR11: a day-long outage leaves the queue intact", async () => {
		const { gateway, clock } = await runOutage(24 * 60 * 60 * 1000);

		const queued = repo.listFailedSends()[0];
		expectToBeDefined(queued);
		expect(queued.terminal).toBe(false);
		expect(queued.attempts).toBe(gateway.refused);
		// A full day of refusals spends most of the budget and still fits: the
		// claim the constant makes is the one this asserts.
		expect(queued.attempts).toBeGreaterThan(50);
		expect(repo.countFailedSends()).toEqual({ pending: 1, terminal: 0 });

		clock.now = Math.max(clock.now, queued.nextRetryAt ?? clock.now);
		await retryQueuedSends(repo, gateway, clock.now);

		expectToBeDefined(createMessageEvent(gateway));
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
	});

	// SR12
	test("SR12: a replayed terminal row goes through the sweep and lands", async () => {
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
		const droppedEvent = queuedEvents(abandoned.eventJson)[0];
		expectToBeDefined(droppedEvent);

		// The appserver recovers and an operator replays the row.
		roomy.failSends({ count: 0 });
		const replayed = repo.replayFailedSend(abandoned.id, Date.now());
		expectToBeDefined(replayed);
		expect(replayed.attempts).toBe(0);
		expect(replayed.terminal).toBe(false);
		expect(replayed.eventJson).toBe(abandoned.eventJson);
		expectToBe(replayed.mappingKind, "message");
		expect(repo.countFailedSends()).toEqual({ pending: 1, terminal: 0 });

		await retryQueuedSends(repo, roomy, replayed.nextRetryAt ?? 0);

		const sent = createMessageEvent(roomy);
		expectToBeDefined(sent);
		// The sweep re-sends the stored event and replays its mapping, so the
		// replay is delivered exactly as a first delivery would have been.
		expect(sent.id).toBe(droppedEvent.id);
		expect(repo.getRoomyId(SPACE_A, "message", MSG_ID)).toBe(droppedEvent.id);
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
	});

	// SR13
	test("SR13: a sweep that outlives its tick does not run twice over one entry", async () => {
		roomy.failSends({ $type: CREATE_TYPE, count: 1 });
		await ingestDiscordMessage(makeMessage({ id: MSG_ID }), repo, roomy);

		const gateway = new BlockingGateway();
		const due = repo.listFailedSends()[0];
		expectToBeDefined(due);
		const at = (due.nextRetryAt ?? 0) + 1;

		// The tick that fires while the first sweep is still waiting on its
		// re-offer must not re-offer the same entry.
		const first = retryQueuedSends(repo, gateway, at);
		const second = retryQueuedSends(repo, gateway, at);
		gateway.release();
		await Promise.all([first, second]);

		expect(gateway.sends).toBe(1);
		expectToBeDefined(createMessageEvent(gateway));
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
	});
});
