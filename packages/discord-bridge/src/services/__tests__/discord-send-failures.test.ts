/**
 * Roomy→Discord send outcomes.
 *
 * Covers: a deterministic Discord refusal (403/404) is stored terminal and a
 * replay of the same Roomy event never reaches Discord again; a rate limit
 * (429) stays pending and the send-retry sweep re-offers it; the stored row
 * survives a restart; a successful send keeps recording its mapping and never
 * writes a failure row.
 */

import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, newUlid, toBytes, Ulid } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { FileDiscordSender } from "../../discord/file-sender.ts";
import { FileWebhookManager } from "../../discord/file-webhook-manager.ts";
import { FileProfileResolver } from "../../roomy/file-profile-resolver.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import { RoomyEventRouter } from "../roomy-event-router.ts";
import {
	queueDiscordSendFailure,
	retryQueuedSends,
	setDiscordRedelivery,
} from "../send-retry.ts";
import { GUILD, ROOMY_CHANNEL_ULID, SPACE_A } from "./helpers/test-data.ts";
import { expectToBe, expectToBeDefined } from "./utils.ts";

const DISCORD_CHANNEL_ID = "800000000000000001";
/** Past every backoff the sweep can schedule (capped at 30 min). */
const LATER = 60 * 60 * 1000;

/** A discordeno REST failure: status and body ride on `error.cause`. */
function discordError(status: number, message: string, code?: number): Error {
	const err = new Error("Failed to send request to discord.");
	Object.assign(err, {
		cause: { ok: false, status, body: JSON.stringify({ message, code }) },
	});
	return err;
}

function makeCreateEvent(id: string, content = "Hello from Roomy"): Event {
	return {
		$type: "space.roomy.message.createMessage.v0",
		id: Ulid.assert(id),
		room: ROOMY_CHANNEL_ULID,
		body: {
			mimeType: "text/markdown",
			data: toBytes(new TextEncoder().encode(content)),
		},
		extensions: {},
	} satisfies Event;
}

function setup(repo = BridgeRepository.open(":memory:")): {
	repo: BridgeRepository;
	roomy: MockRoomyGateway;
	discord: FileDiscordSender;
	router: RoomyEventRouter;
} {
	repo.upsertBridgeConfig(GUILD, SPACE_A, "full");
	repo.registerMapping(
		SPACE_A,
		"channel",
		DISCORD_CHANNEL_ID,
		ROOMY_CHANNEL_ULID,
	);

	const roomy = new MockRoomyGateway();
	const discord = new FileDiscordSender();
	const router = new RoomyEventRouter(
		roomy,
		discord,
		new FileWebhookManager(),
		new FileProfileResolver(),
		repo,
		{ fetchAttachment: async () => new Uint8Array() },
	);
	// The sweep redelivers through the router, as the bridge wires it at boot.
	setDiscordRedelivery((entry, event) =>
		router.redeliver(entry.spaceDid, event, {
			userDid: entry.userDid ?? "",
		}),
	);
	return { repo, roomy, discord, router };
}

afterEach(() => {
	setDiscordRedelivery(undefined);
});

describe("Roomy→Discord send outcomes", () => {
	for (const status of [403, 404]) {
		test(`SF0${status === 403 ? 1 : 2}: a ${status} send is terminal and a replay does not re-send`, async () => {
			const { repo, roomy, discord, router } = setup();
			await router.subscribeToSpace(SPACE_A);
			discord.setSendError(
				discordError(
					status,
					status === 403 ? "Missing Permissions" : "Unknown Message",
					status === 403 ? 50013 : 10008,
				),
			);

			const event = makeCreateEvent(newUlid());
			await roomy.fireEvent(SPACE_A, event);

			const recorded = repo.getDiscordSendFailure(SPACE_A, event.id);
			expectToBeDefined(recorded);
			expect(recorded.terminal).toBe(true);
			expectToBe(recorded.direction, "to_discord");
			expectToBe(recorded.roomyEventId, event.id);
			expect(recorded.lastError).toContain(String(status));
			expect(discord.sendAttempts).toBe(1);

			// The stream replays the same event (e.g. after a reconnect).
			await roomy.fireEvent(SPACE_A, event);
			expect(discord.sendAttempts).toBe(1);
			expect(discord.sent).toHaveLength(0);
			expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 1 });
		});
	}

	test("SF03: the error line names the status and classification", async () => {
		const { roomy, discord, router } = setup();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await router.subscribeToSpace(SPACE_A);
			discord.setSendError(discordError(403, "Missing Permissions", 50013));
			await roomy.fireEvent(SPACE_A, makeCreateEvent(newUlid()));

			const line = errorSpy.mock.calls
				.map((call) => String(call[0]))
				.map((raw) => {
					let fields: Record<string, unknown> = {};
					try {
						fields = JSON.parse(raw) ?? {};
					} catch {
						// A non-JSON line carries no structured fields.
					}
					return fields;
				})
				.find(
					(fields) =>
						fields.msg ===
						"Roomy→Discord send failed; Discord refused it, not retrying",
				);
			expectToBeDefined(line);
			expect(line.status).toBe(403);
			expect(line.classification).toBe("missing_permissions");
			expect(line.retryable).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("SF04: a 429 send stays pending, is skipped on replay, and the sweep lands it", async () => {
		const { repo, roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);
		const event = makeCreateEvent(newUlid());

		discord.setSendError(discordError(429, "You are being rate limited"));
		await roomy.fireEvent(SPACE_A, event);

		const queued = repo.getDiscordSendFailure(SPACE_A, event.id);
		expectToBeDefined(queued);
		expect(queued.terminal).toBe(false);
		expect(queued.nextRetryAt).not.toBeNull();
		expect(repo.countFailedSends()).toEqual({ pending: 1, terminal: 0 });

		// A replay must not race the sweep for the same event.
		await roomy.fireEvent(SPACE_A, event);
		expect(discord.sendAttempts).toBe(1);

		discord.setSendError(null);
		await retryQueuedSends(repo, roomy, Date.now() + LATER);

		expect(discord.sendAttempts).toBe(2);
		expect(discord.sent).toHaveLength(1);
		expect(repo.getDiscordSendFailure(SPACE_A, event.id)).toBeNull();
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
		expect(repo.getDiscordId(SPACE_A, "message", event.id)).toBeDefined();
	});

	test("SF05: the recorded outcome survives a restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roomy-send-failure-"));
		const dbPath = join(dir, "bridge.sqlite");
		try {
			const repo1 = setup(BridgeRepository.open(dbPath)).repo;
			queueDiscordSendFailure(repo1, {
				spaceDid: SPACE_A,
				op: "message_create",
				event: makeCreateEvent(newUlid()),
				userDid: "did:plc:test-user",
				error: discordError(404, "Unknown Message", 10008),
			});
			const recorded = repo1.listFailedSends()[0];
			expectToBeDefined(recorded);
			expect(recorded.terminal).toBe(true);
			repo1.close();

			// "Restart": reopen the same file — the terminal row (and its
			// event id) must still there, so the replay skips it.
			const repo2 = BridgeRepository.open(dbPath);
			const persisted = repo2.getDiscordSendFailure(
				SPACE_A,
				recorded.roomyEventId ?? "",
			);
			expectToBeDefined(persisted);
			expect(persisted.terminal).toBe(true);
			expectToBe(persisted.lastError?.includes("not_found"), true);
			repo2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("SF06: a successful send records its mapping and no failure row", async () => {
		const { repo, roomy, discord, router } = setup();
		await router.subscribeToSpace(SPACE_A);
		const event = makeCreateEvent(newUlid());

		await roomy.fireEvent(SPACE_A, event);
		await roomy.fireEvent(SPACE_A, event);

		expect(discord.sent).toHaveLength(1);
		expect(discord.sendAttempts).toBe(1);
		expect(repo.getDiscordId(SPACE_A, "message", event.id)).toBe(
			discord.sent[0]?.messageId,
		);
		expect(repo.countFailedSends()).toEqual({ pending: 0, terminal: 0 });
	});
});
