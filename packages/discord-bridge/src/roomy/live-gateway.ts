/**
 * LiveRoomyGateway: wraps SpaceManager to send events to real Roomy spaces
 * and subscribe to events from Roomy spaces.
 *
 * Subscriptions use the SDK's SyncConnection with a `stream` topic. The
 * appserver backfills events from a persisted cursor, then streams live
 * events as `#streamEvents` CBOR frames. Each frame carries a batch of
 * decoded events, a cursor (the last-delivered idx), and a `hasMore` flag.
 */

import { type Event, sync, transport } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import { createLogger } from "../logger.ts";
import type { RoomyEventCallback, RoomyGateway } from "./gateway.ts";
import type { SpaceManager } from "./space-manager.ts";

const log = createLogger("live-roomy");

/** Shape of a single event in a #streamEvents frame body. */
interface StreamEventEntry {
	idx: number;
	user: string;
	payload: Record<string, unknown>;
}

/** Shape of a #streamEvents frame body. */
interface StreamEventsBody {
	streamDid: string;
	cursor: number;
	hasMore: boolean;
	events: StreamEventEntry[];
}

export class LiveRoomyGateway implements RoomyGateway {
	#spaceManager: SpaceManager;
	#repo: BridgeRepository;
	#xrpc: transport.DirectXrpcClient;
	#appserverWsUrl: string;
	/** Track active subscriptions per space so we can unsubscribe. */
	#subscriptions = new Set<string>();
	/** Per-space SyncConnection instances. */
	#connections = new Map<string, sync.SyncConnection>();
	/** Per-space processing chain — ensures frames are processed sequentially. */
	#processing = new Map<string, Promise<void>>();

	constructor(
		spaceManager: SpaceManager,
		repo: BridgeRepository,
		xrpc: transport.DirectXrpcClient,
		appserverWsUrl: string,
	) {
		this.#spaceManager = spaceManager;
		this.#repo = repo;
		this.#xrpc = xrpc;
		this.#appserverWsUrl = appserverWsUrl;
	}

	async sendEvent(spaceDid: string, event: Event): Promise<void> {
		await this.sendEvents(spaceDid, [event]);
	}

	async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
		await this.#xrpc.procedure("space.roomy.space.sendEvents", {
			spaceId: spaceDid,
			events: events.map((e) => ({ ...e })),
		});
	}

	async subscribe(
		spaceDid: string,
		callback: RoomyEventCallback,
	): Promise<void> {
		if (this.#subscriptions.has(spaceDid)) {
			log.warn(`Already subscribed to ${spaceDid}, skipping`);
			return;
		}
		// Register immediately to guard against concurrent subscribe calls.
		this.#subscriptions.add(spaceDid);

		// Resume from the persisted cursor so we don't re-backfill the entire
		// space history on every restart. The cursor is exclusive (last-seen
		// idx); use -1 for full backfill when no cursor is persisted.
		const persisted = this.#repo.getSpaceCursor(spaceDid);
		const cursor = persisted !== undefined ? persisted : -1;

		const connection = new sync.SyncConnection({
			fetchTicket: async () => {
				const { ticket } = await this.#xrpc.procedure(
					"space.roomy.auth.getConnectionTicket",
					{},
				);
				return ticket;
			},
			wsUrl: this.#appserverWsUrl,
			logger: log.debug,
			// Keep idle sync WebSockets alive: Bun's WebSocket exposes
			// protocol-level ping/pong, and the appserver auto-replies with
			// pong (RFC 6455). Without a heartbeat, idle connections are
			// silently dropped by intermediaries and the bridge only notices
			// when it tries to send — by then events have been missed.
			heartbeat: {},
		});

		// Subscribe to the stream topic with the cursor. The server backfills
		// events with idx > cursor, then streams live events. This initial
		// subscription is tracked by the SDK and replayed on reconnect; the
		// onOpen handler below re-subscribes with a fresh cursor to override
		// that replay (see M3).
		connection.subscribe({ kind: "stream", id: spaceDid, cursor });

		// Per-space backfill state. The first frame(s) with hasMore=true are
		// backfill; once a frame arrives with hasMore=false the backfill is
		// done and all later frames are live. See L1 for the semantics.
		const backfillState = { value: true };

		// On every (re)connect, re-subscribe with the fresh cursor from the
		// repo. The SDK replays the topic registered above using the cursor
		// captured at subscribe() time, which goes stale as the persisted
		// cursor advances — a reconnect would then re-backfill from the stale
		// cursor. We unsubscribe the stale topic and re-subscribe with the
		// up-to-date cursor so reconnects resume from where we left off.
		connection.onOpen(() => {
			// M3: re-enter the backfill phase on every reconnect. The first
			// open after the initial backfill completed has backfillState
			// stuck at false; without resetting, a reconnect's backfill
			// frames (hasMore=true) would be mislabeled isBackfill=false.
			backfillState.value = true;
			const freshCursor = this.#repo.getSpaceCursor(spaceDid) ?? -1;
			// Drop any in-flight processing chain from the previous socket.
			// Frames on the old connection may still be working through
			// callbacks (e.g. a slow profile fetch). A rejected leftover would
			// serialise new frames behind a dead promise; clearing lets frames
			// arriving on this fresh connection chain from a clean base.
			this.#processing.delete(spaceDid);
			connection.unsubscribe({ kind: "stream", id: spaceDid });
			connection.subscribe({ kind: "stream", id: spaceDid, cursor: freshCursor });
		});

		connection.onFrame((frame: sync.SyncFrame) => {
			const t = frame.header["t"];
			if (t !== "#streamEvents") return;
			// Chain this frame onto any in-flight processing for this space
			// so frames are processed sequentially (not concurrently).
			const previous = this.#processing.get(spaceDid) ?? Promise.resolve();
			const current = previous
				.then(() =>
					this.#processFrame(spaceDid, frame.body, callback, backfillState),
				)
				.catch((err) => {
					log.error(`Error processing stream frame for ${spaceDid}`, err);
				});
			this.#processing.set(spaceDid, current);
		});

		// Connection-level lifecycle logging so WebSocket drops, reconnect
		// attempts, and frame decode failures are observable rather than
		// silent. The SDK also forwards its own human-readable status lines
		// to the `logger` option above (debug); these handlers cover the
		// structured error/close/status signals.
		connection.onError((err: unknown) => {
			log.error(`Connection error for ${spaceDid}`, err);
		});
		connection.onClose((info: sync.CloseEventInfo) => {
			log.warn(
				`Connection closed for ${spaceDid}: code=${info.code} reason=${info.reason}` +
					(info.intentional ? " (intentional)" : ""),
			);
		});
		connection.onStatusChange((status: sync.ConnectionStatus) => {
			log.info(`Connection status for ${spaceDid}: ${status.state}`, status);
		});

		// Open the WebSocket connection. Must be called after subscribe() so
		// the topic is registered before the socket opens (the connect()
		// method replays tracked subscriptions on open). If connect() fails,
		// drop the subscription so a later subscribe() can retry (M2).
		try {
			await connection.connect();
		} catch (err) {
			// Kill the SDK's reconnect timer: connect() may have scheduled a
			// reconnect via #handleAbnormalClose on a partial failure. close()
			// sets #intentionalClose and clears that timer, so the connection
			// can't zombie-reconnect and deliver frames for a failed subscribe.
			connection.close();
			this.#subscriptions.delete(spaceDid);
			throw err;
		}

		this.#connections.set(spaceDid, connection);
		log.info(
			`Subscribed to events from ${spaceDid}` +
				(persisted !== undefined
					? ` (resuming from idx ${persisted + 1})`
					: " (full backfill)"),
		);
	}

	/**
	 * Process a #streamEvents frame: invoke the callback for each event, then
	 * persist the cursor. Each callback invocation is wrapped so a single
	 * failing handler doesn't block the rest of the batch.
	 *
	 * `backfillState` carries the per-space backfill flag across frames (L1).
	 */
	async #processFrame(
		spaceDid: string,
		body: Record<string, unknown>,
		callback: RoomyEventCallback,
		backfillState: { value: boolean },
	): Promise<void> {
		const data = body as unknown as StreamEventsBody;
		if (!data || !Array.isArray(data.events)) return;

		// L1: `isBackfill` describes the state at the *start* of this frame,
		// not the server's signal for the *next* frame. The final backfill
		// batch still carries historical events, so it should be flagged as
		// backfill. We only exit the backfill phase after processing a frame
		// that the server says completes the backfill (hasMore=false).
		const wasBackfill = backfillState.value;
		const isBackfill = wasBackfill;

		for (const entry of data.events) {
			const event = entry.payload;
			// Validate the payload has a $type before passing it to the
			// callback — skip malformed events without aborting the batch.
			if (!event || typeof event !== "object" || !("$type" in event)) {
				log.warn(
					`Skipping malformed event idx ${entry.idx} for ${spaceDid}`,
				);
				continue;
			}

			try {
				await callback(event as Event, {
					spaceDid,
					isBackfill,
					userDid: entry.user,
				});
			} catch (cbErr) {
				const errorMessage =
					cbErr instanceof Error ? cbErr.message : String(cbErr);
				log.error(
					`Event callback failed for ${spaceDid} idx ${entry.idx}: ${errorMessage}`,
				);
				this.#repo.logEventError(
					spaceDid,
					entry.idx,
					String(event.$type),
					errorMessage,
				);
			}
		}

		// M4: persist the cursor AFTER the callbacks have run so a crash
		// between persisting and delivering doesn't permanently lose events
		// (at-least-once delivery). Per-event errors are logged above and do
		// not block forward progress.
		this.#repo.setSpaceCursor(spaceDid, data.cursor);

		// Only exit the backfill phase once the server signals this frame
		// completed the backfill.
		if (wasBackfill && !data.hasMore) backfillState.value = false;
	}

	async unsubscribe(spaceDid: string): Promise<void> {
		if (!this.#subscriptions.has(spaceDid)) return;

		const connection = this.#connections.get(spaceDid);
		if (connection) {
			connection.close();
		}
		this.#connections.delete(spaceDid);
		this.#subscriptions.delete(spaceDid);
		this.#processing.delete(spaceDid);
		log.info(`Unsubscribed from ${spaceDid}`);
	}

	async disconnectAll(): Promise<void> {
		for (const conn of this.#connections.values()) {
			conn.close();
		}
		this.#connections.clear();
		this.#subscriptions.clear();
		this.#processing.clear();
		await this.#spaceManager.disconnectAll();
	}
}