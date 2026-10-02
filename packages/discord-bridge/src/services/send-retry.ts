import type { Event } from "@roomy-space/sdk";
import type {
	BridgeRepository,
	FailedSend,
	MappingKind,
} from "../db/repository.ts";
import { createLogger } from "../logger.ts";
import { getCapacityGate } from "../roomy/capacity.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";

const log = createLogger("send-retry");

/**
 * Kind of send queued in `failed_sends`. Part of the queue key, so a message
 * create, the edit that follows it and the delete that ends it each get a row.
 */
export type SendOp = "message_create" | "message_edit" | "message_delete";

/** Re-offers before a queued entry is abandoned. */
export const SEND_SWEEP_MAX_ATTEMPTS = 8;
/** Delay before the first re-offer, doubled per attempt up to the cap. */
const SWEEP_BASE_MS = 30_000;
const SWEEP_MAX_MS = 30 * 60_000;
/** Entries examined per sweep. */
const SWEEP_BATCH_LIMIT = 50;

export type DurableSend = {
	spaceDid: string;
	op: SendOp;
	/** Discord snowflake the event concerns; keys the queue entry. */
	discordId: string;
	event: Event;
	/** Mapping registered once the event lands — null for pure mutations. */
	mapping: { kind: MappingKind; value: string } | null;
};

/**
 * Send one event, and on failure queue it durably instead of dropping it.
 *
 * The send is attempted once. Ingest runs from a Discord gateway packet, and
 * discordeno neither serializes packet handling nor awaits the event handler,
 * so a second inline attempt buys no ordering: it only adds latency before the
 * message's own bookkeeping lands, and the dominant failure is already a 20s
 * XRPC timeout. Re-offering is the sweep's job (`retryQueuedSends`), out of
 * band, with backoff, and across restarts.
 *
 * Returns true when the event landed, in which case the caller runs its own
 * post-send bookkeeping; the sweep registers the mapping when a queued entry
 * lands later.
 */
export async function sendEventOrQueue(
	repo: BridgeRepository,
	roomy: RoomyGateway,
	send: DurableSend,
): Promise<boolean> {
	try {
		await roomy.sendEvent(send.spaceDid, send.event);
		return true;
	} catch (err) {
		const error = describe(err);
		repo.enqueueFailedSend({
			spaceDid: send.spaceDid,
			op: send.op,
			discordId: send.discordId,
			mappingKind: send.mapping?.kind ?? null,
			mappingValue: send.mapping?.value ?? null,
			eventJson: JSON.stringify(send.event),
			error,
			attempts: 1,
			nextRetryAt: Date.now() + sweepBackoffMs(1),
		});
		// Stable text on purpose: the log pipeline groups series by the message
		// line, so interpolating the message id here would give every dropped
		// send its own series and hide a burst. Identifiers ride in the fields.
		log.error("Discord→Roomy send failed; queued for re-offer", {
			op: send.op,
			spaceDid: send.spaceDid,
			discordId: send.discordId,
			error,
		});
		return false;
	}
}

/**
 * Re-offer queued sends whose backoff has elapsed. An entry that lands is
 * deleted and its mapping registered; one that keeps failing backs off until
 * SEND_SWEEP_MAX_ATTEMPTS, then goes terminal. Terminal rows are kept, so
 * `countFailedSends()` stays a true count of everything the bridge dropped.
 */
export async function retryQueuedSends(
	repo: BridgeRepository,
	roomy: RoomyGateway,
	now: number = Date.now(),
): Promise<void> {
	const due = repo.getStaleFailedSends(now, SWEEP_BATCH_LIMIT);
	if (due.length === 0) return;

	// A space whose every bridged guild is over capacity must not receive
	// traffic; its entries wait (without burning an attempt) until it drains.
	const configs = repo.listAllBridgeConfigs();
	const haltedSpaces = new Set<string>();
	for (const spaceDid of new Set(due.map((entry) => entry.spaceDid))) {
		const bridged = configs.filter((config) => config.spaceDid === spaceDid);
		if (bridged.length === 0) continue;
		const enabled = await Promise.all(
			bridged.map((config) =>
				getCapacityGate().isEnabled(config.guildId, spaceDid),
			),
		);
		if (!enabled.some(Boolean)) haltedSpaces.add(spaceDid);
	}

	for (const entry of due) {
		if (haltedSpaces.has(entry.spaceDid)) {
			log.warn("Discord→Roomy send re-offer held: capacity halted", {
				op: entry.op,
				spaceDid: entry.spaceDid,
				discordId: entry.discordId,
			});
			continue;
		}

		const event = parseQueuedEvent(entry);
		if (!event) {
			repo.markFailedSendTerminal(entry.id, "unreadable event payload");
			log.error("Discord→Roomy send abandoned: unreadable payload", {
				op: entry.op,
				spaceDid: entry.spaceDid,
				discordId: entry.discordId,
			});
			continue;
		}

		try {
			await roomy.sendEvent(entry.spaceDid, event);
			if (entry.mappingKind && entry.mappingValue) {
				repo.registerMapping(
					entry.spaceDid,
					entry.mappingKind,
					entry.discordId,
					entry.mappingValue,
				);
			}
			repo.deleteFailedSend(entry.id);
			log.info("Discord→Roomy send re-offer landed", {
				op: entry.op,
				spaceDid: entry.spaceDid,
				discordId: entry.discordId,
				attempts: entry.attempts,
			});
		} catch (err) {
			const error = describe(err);
			const attempts = entry.attempts + 1;
			if (attempts >= SEND_SWEEP_MAX_ATTEMPTS) {
				repo.markFailedSendTerminal(entry.id, error);
				log.error("Discord→Roomy send abandoned after re-offers", {
					op: entry.op,
					spaceDid: entry.spaceDid,
					discordId: entry.discordId,
					attempts,
					error,
				});
			} else {
				repo.bumpFailedSendAttempt(
					entry.id,
					error,
					Date.now() + sweepBackoffMs(attempts),
				);
				log.warn("Discord→Roomy send re-offer failed; will retry", {
					op: entry.op,
					spaceDid: entry.spaceDid,
					discordId: entry.discordId,
					attempts,
					error,
				});
			}
		}
	}
}

/** Delay before re-offer number `attempt`: base doubled, capped. */
function sweepBackoffMs(attempt: number): number {
	return Math.min(SWEEP_BASE_MS * 2 ** (attempt - 1), SWEEP_MAX_MS);
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Decode a queued event; null when the stored payload carries no event. */
function parseQueuedEvent(entry: FailedSend): Event | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(entry.eventJson);
	} catch {
		return null;
	}
	return isEventLike(parsed) ? parsed : null;
}

/** An event is anything with a string `id`; the rest is opaque to the sweep. */
function isEventLike(value: unknown): value is Event {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string"
	);
}
