import type { Event } from "@roomy-space/sdk";
import type {
	BridgeRepository,
	FailedSend,
	MappingKind,
} from "../db/repository.ts";
import { describeDiscordFailure } from "../discord/rest-errors.ts";
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

/** Which Roomy→Discord send failed; recorded on the durable row. */
export type DiscordSendOp =
	| "message_create"
	| "message_edit"
	| "message_delete"
	| "reaction_add"
	| "message_forward"
	| "message_move";

/**
 * Failed delivery attempts before a queued entry is abandoned — one per
 * recorded failure, in both the live path and the sweep. With the backoff
 * below this spans ~29 h: the first six waits total ~31 min, then 57 waits at
 * the 30-minute cap. A space that refuses every send for a day keeps its
 * queue; only a space that refuses one for longer loses a message.
 */
export const SEND_SWEEP_MAX_ATTEMPTS = 64;
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
 * Deliver one queued Roomy→Discord entry. The router installs this at boot
 * through {@link setDiscordRedelivery}: the router imports this module, so
 * the sweep cannot import it back.
 */
export type DiscordRedelivery = (
	entry: FailedSend,
	event: Event,
) => Promise<void>;

let discordRedelivery: DiscordRedelivery | undefined;

/** Install (or clear) the router's redelivery path. */
export function setDiscordRedelivery(fn: DiscordRedelivery | undefined): void {
	discordRedelivery = fn;
}

/**
 * Record a Roomy→Discord delivery Discord refused and say whether the sweep
 * should keep trying. A 4xx other than 429 is a decision backoff cannot
 * change, so the entry is written terminal: every replay of the event skips
 * it instead of re-sending forever. Everything else (429, 5xx, 999, no status)
 * stays pending for the re-offer sweep, so a transient failure is still
 * delivered later.
 */
export function queueDiscordSendFailure(
	repo: BridgeRepository,
	failure: {
		spaceDid: string;
		op: DiscordSendOp;
		event: Event;
		userDid: string;
		error: unknown;
	},
): void {
	const detail = describeDiscordFailure(failure.error);
	repo.enqueueDiscordSendFailure({
		spaceDid: failure.spaceDid,
		op: failure.op,
		eventId: failure.event.id,
		userDid: failure.userDid,
		eventJson: JSON.stringify([failure.event]),
		error: detail.text,
		terminal: !detail.retryable,
		nextRetryAt: detail.retryable ? Date.now() + sweepBackoffMs(1) : null,
	});
	// Stable text on purpose: a per-event message line would give every drop
	// its own log series and hide a burst. Identifiers ride in the fields.
	const fields = {
		op: failure.op,
		spaceDid: failure.spaceDid,
		eventId: failure.event.id,
		status: detail.status,
		classification: detail.classification,
		retryable: detail.retryable,
		error: detail.message,
		discordError: detail.detail,
	};
	if (detail.retryable) {
		log.warn("Roomy→Discord send failed; queued for re-offer", fields);
	} else {
		log.error(
			"Roomy→Discord send failed; Discord refused it, not retrying",
			fields,
		);
	}
}

/**
 * Re-offer queued sends whose backoff has elapsed. An entry that lands is
 * deleted and its mapping replayed; one that keeps failing backs off until
 * SEND_SWEEP_MAX_ATTEMPTS, then goes terminal. Terminal rows are kept, so
 * `countFailedSends()` stays a true count of everything the bridge dropped;
 * `BridgeRepository.replayFailedSend` puts one back in the queue.
 *
 * One sweep runs at a time. During an outage every re-offer waits out the
 * XRPC timeout, so a full batch outlasts the caller's minute tick; the
 * overlapping sweeps a longer batch would allow re-send the same entry and
 * spend one attempt each for what is a single delivery window.
 */
export async function retryQueuedSends(
	repo: BridgeRepository,
	roomy: RoomyGateway,
	now: number = Date.now(),
): Promise<void> {
	if (sweepInFlight) {
		log.warn("Send re-offer sweep skipped: previous sweep still running", {});
		return;
	}
	sweepInFlight = true;
	try {
		await sweepQueuedSends(repo, roomy, now);
	} finally {
		sweepInFlight = false;
	}
}

let sweepInFlight = false;

async function sweepQueuedSends(
	repo: BridgeRepository,
	roomy: RoomyGateway,
	now: number,
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
		if (entry.direction === "to_roomy" && haltedSpaces.has(entry.spaceDid)) {
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
			if (entry.direction === "to_discord") {
				await redeliverDiscordEntry(entry, events);
			} else {
				await roomy.sendEvents(entry.spaceDid, events);
				// The mapping is replayed here rather than by the caller: a queued
				// send lands outside the handler that issued it, and only what is
				// stored on the entry can be replayed. A Roomy→Discord entry needs
				// none: its handler registers the mapping itself when it lands.
				if (entry.mappingKind && entry.discordId !== null) {
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
			}
			repo.deleteFailedSend(entry.id);
			log.info(
				entry.direction === "to_discord"
					? "Roomy→Discord send re-offer landed"
					: "Discord→Roomy send re-offer landed",
				{
					op: entry.op,
					spaceDid: entry.spaceDid,
					...(entry.direction === "to_discord"
						? { eventId: entry.roomyEventId }
						: { discordId: entry.discordId }),
					attempts: entry.attempts,
				},
			);
		} catch (err) {
			const failure =
				entry.direction === "to_discord" ? describeDiscordFailure(err) : null;
			// Discord answering 4xx (other than 429) will answer the same way
			// on every re-offer, so the entry goes terminal on the first one
			// instead of spending the whole attempt budget.
			if (failure && !failure.retryable) {
				repo.recordFailedSendAttempt(entry.id, failure.text);
				repo.markFailedSendTerminal(entry.id, failure.text);
				log.error("Roomy→Discord send abandoned: Discord refused it", {
					op: entry.op,
					spaceDid: entry.spaceDid,
					eventId: entry.roomyEventId,
					status: failure.status,
					classification: failure.classification,
					error: failure.message,
					discordError: failure.detail,
				});
				continue;
			}
			const error = failure ? failure.text : describe(err);
			// The repository is the only writer of `attempts`, and the count it
			// returns decides the delay and the terminal test alike: one failed
			// delivery costs exactly one attempt, and no count read before this
			// attempt can schedule past the budget. The delay is measured from
			// the sweep's own clock, the same one that decided what was due.
			const attempts = repo.recordFailedSendAttempt(entry.id, error);
			const target =
				entry.direction === "to_discord"
					? { eventId: entry.roomyEventId }
					: { discordId: entry.discordId };
			if (attempts >= SEND_SWEEP_MAX_ATTEMPTS) {
				repo.markFailedSendTerminal(entry.id, error);
				log.error(
					entry.direction === "to_discord"
						? "Roomy→Discord send abandoned after re-offers"
						: "Discord→Roomy send abandoned after re-offers",
					{
						op: entry.op,
						spaceDid: entry.spaceDid,
						...target,
						attempts,
						error,
						...(failure
							? {
									status: failure.status,
									classification: failure.classification,
								}
							: {}),
					},
				);
			} else {
				repo.scheduleFailedSendRetry(entry.id, now + sweepBackoffMs(attempts));
				log.warn(
					entry.direction === "to_discord"
						? "Roomy→Discord send re-offer failed; will retry"
						: "Discord→Roomy send re-offer failed; will retry",
					{
						op: entry.op,
						spaceDid: entry.spaceDid,
						...target,
						attempts,
						error,
						...(failure
							? {
									status: failure.status,
									classification: failure.classification,
								}
							: {}),
					},
				);
			}
		}
	}
}

/** Re-run one queued Roomy→Discord event through the router. */
async function redeliverDiscordEntry(
	entry: FailedSend,
	events: Event[],
): Promise<void> {
	if (!discordRedelivery) {
		throw new Error("no Roomy→Discord redelivery installed");
	}
	for (const event of events) {
		await discordRedelivery(entry, event);
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
