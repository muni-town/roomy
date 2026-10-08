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
export type SendOp =
	| "message_create"
	| "message_edit"
	| "message_delete"
	| "room_create"
	| "room_update"
	| "room_delete";

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
	/** Discord snowflake the send concerns; keys the queue entry. */
	discordId: string;
	/** Delivered as one atomic call; a thread create carries its room and link. */
	events: Event[];
	/**
	 * The mapping this send establishes, replayed once when the entry lands.
	 * `value: null` removes the mapping instead (a deleted room); a null
	 * `mapping` leaves the table alone for a pure mutation.
	 */
	mapping: { kind: MappingKind; value: string | null } | null;
};

/**
 * Send the events, and on failure queue them durably instead of dropping them.
 *
 * The send is attempted once. Ingest runs from a Discord gateway packet, and
 * discordeno neither serializes packet handling nor awaits the event handler,
 * so a second inline attempt buys no ordering: it only adds latency before the
 * message's own bookkeeping lands, and the dominant failure is already a 20s
 * XRPC timeout. Re-offering is the sweep's job (`retryQueuedSends`), out of
 * band, with backoff, and across restarts.
 *
 * Returns true when the send landed, in which case the caller runs its own
 * post-send bookkeeping; the sweep replays the entry's mapping when a queued
 * send lands later.
 */
export async function sendEventOrQueue(
	repo: BridgeRepository,
	roomy: RoomyGateway,
	send: DurableSend,
): Promise<boolean> {
	try {
		await roomy.sendEvents(send.spaceDid, send.events);
		return true;
	} catch (err) {
		const error = describe(err);
		repo.enqueueFailedSend({
			spaceDid: send.spaceDid,
			op: send.op,
			discordId: send.discordId,
			mappingKind: send.mapping?.kind ?? null,
			mappingValue: send.mapping?.value ?? null,
			eventJson: JSON.stringify(send.events),
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
 * deleted and its mapping replayed; one that keeps failing backs off until
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

		const events = parseQueuedEvents(entry);
		if (!events) {
			repo.markFailedSendTerminal(entry.id, "unreadable event payload");
			log.error("Discord→Roomy send abandoned: unreadable payload", {
				op: entry.op,
				spaceDid: entry.spaceDid,
				discordId: entry.discordId,
			});
			continue;
		}

		try {
			await roomy.sendEvents(entry.spaceDid, events);
			// The mapping is replayed here rather than by the caller: a queued
			// send lands outside the handler that issued it, and only what is
			// stored on the entry can be replayed.
			if (entry.mappingKind) {
				if (entry.mappingValue === null) {
					repo.unregisterMapping(
						entry.spaceDid,
						entry.mappingKind,
						entry.discordId,
					);
				} else {
					repo.registerMapping(
						entry.spaceDid,
						entry.mappingKind,
						entry.discordId,
						entry.mappingValue,
					);
				}
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

/**
 * Decode a queued payload into the events to send; null when it carries none.
 * Entries written before sends could carry more than one event hold a bare
 * event object; either shape decodes to the same list.
 */
function parseQueuedEvents(entry: FailedSend): Event[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(entry.eventJson);
	} catch {
		return null;
	}
	if (Array.isArray(parsed)) {
		return parsed.length > 0 && parsed.every(isEventLike) ? parsed : null;
	}
	return isEventLike(parsed) ? [parsed] : null;
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
