/**
 * Tests for the HTTP status surface.
 *
 * Covers: APIS01–APIS02 — /sends/failed reports the durable failed-send queue,
 * so an operator can see which sends the bridge still owes a space and which it
 * gave up on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ApiServer, startApi } from "../api.ts";
import { BridgeRepository } from "../db/repository.ts";
import { SPACE_A, SPACE_B } from "../services/__tests__/helpers/test-data.ts";

let repo: BridgeRepository;
let server: ApiServer;
let origPort: string | undefined;

/** Queue one entry for a space, optionally already abandoned. */
function queue(spaceDid: string, discordId: string, terminal = false): void {
	repo.enqueueFailedSend({
		spaceDid,
		op: "message_create",
		discordId,
		mappingKind: "message",
		mappingValue: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		eventJson: '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
		error: "XRPC space.roomy.space.sendEvents timed out after 20000ms",
		attempts: 1,
		nextRetryAt: Date.now(),
	});
	if (terminal) {
		const entry = repo
			.listFailedSends()
			.find(
				(send) => send.spaceDid === spaceDid && send.discordId === discordId,
			);
		if (entry) repo.markFailedSendTerminal(entry.id, "gave up");
	}
}

/** The /sends/failed response body. */
type FailedSendsPayload = {
	pending: number;
	terminal: number;
	sends: Record<string, unknown>[];
};

function isFailedSendsPayload(value: unknown): value is FailedSendsPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		"pending" in value &&
		typeof value.pending === "number" &&
		"terminal" in value &&
		typeof value.terminal === "number" &&
		"sends" in value &&
		Array.isArray(value.sends)
	);
}

async function getFailedSends(query: string): Promise<FailedSendsPayload> {
	const res = await fetch(
		`http://127.0.0.1:${server.port}/sends/failed${query}`,
	);
	expect(res.status).toBe(200);
	const body: unknown = await res.json();
	if (!isFailedSendsPayload(body)) {
		throw new Error(
			`unexpected /sends/failed payload: ${JSON.stringify(body)}`,
		);
	}
	return body;
}

beforeEach(() => {
	origPort = process.env.PORT;
	// Port 0 lets the OS pick a free port, so the test never fights a running
	// bridge instance.
	process.env.PORT = "0";
	repo = BridgeRepository.open(":memory:");
	server = startApi(repo, () => "app-1");
});

afterEach(() => {
	server.stop(true);
	if (origPort === undefined) delete process.env.PORT;
	else process.env.PORT = origPort;
});

describe("/sends/failed", () => {
	// APIS01
	test("APIS01: reports queue depth and entries for one space, without event payloads", async () => {
		queue(SPACE_A, "42");
		queue(SPACE_A, "43", true);
		queue(SPACE_B, "44");

		const body = await getFailedSends(`?spaceDid=${SPACE_A}`);

		expect(body.pending).toBe(1);
		expect(body.terminal).toBe(1);
		expect(body.sends.length).toBe(2);
		const entry = body.sends.find((send) => send.discordId === "42");
		expect(entry?.op).toBe("message_create");
		expect(entry?.attempts).toBe(1);
		expect(entry?.lastError).toContain("timed out");
		// The payload is internal: the endpoint is a status read, not a replay.
		expect(entry?.eventJson).toBeUndefined();
		expect(entry?.mappingValue).toBeUndefined();
	});

	// APIS02
	test("APIS02: counts every space when unscoped", async () => {
		queue(SPACE_A, "42");
		queue(SPACE_B, "44");

		const body = await getFailedSends("");

		expect(body.pending).toBe(2);
		expect(body.sends.length).toBe(2);
	});
});
