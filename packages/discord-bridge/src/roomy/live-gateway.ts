/**
 * LiveRoomyGateway: wraps SpaceManager to send events to real Roomy spaces
 * and subscribe to events from Roomy spaces.
 *
 * Subscriptions use the SDK's SyncConnection for WebSocket-based sync.
 */

import { decode, fromBytes } from "@atcute/cbor";
import { type Event, sync, transport } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import { createLogger } from "../logger.ts";
import type { RoomyEventCallback, RoomyGateway } from "./gateway.ts";
import type { SpaceManager } from "./space-manager.ts";

const log = createLogger("live-roomy");

export class LiveRoomyGateway implements RoomyGateway {
	#spaceManager: SpaceManager;
	#repo: BridgeRepository;
	#xrpc: transport.DirectXrpcClient;
	#appserverWsUrl: string;
	/** Track active subscriptions per space so we can unsubscribe. */
	#subscriptions = new Set<string>();
	/** Per-space SyncConnection instances. */
	#connections = new Map<string, sync.SyncConnection>();

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
			events: events.map(e => ({ ...e })),
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

		// Resume from the persisted cursor so we don't re-backfill the entire
		// space history on every restart.
		const cursor = this.#repo.getSpaceCursor(spaceDid);

		// Track cursor as a mutable variable so it advances with each poll.
		let currentCursor = cursor;

		const connection = new sync.SyncConnection({
			fetchTicket: async () => {
				const { ticket } = await this.#xrpc.procedure("space.roomy.auth.getConnectionTicket", {});
				return ticket;
			},
			wsUrl: this.#appserverWsUrl,
		});

		connection.subscribe({ kind: "space", id: spaceDid });

		connection.onFrame(async (_frame: sync.SyncFrame) => {
			// The appserver sync system sends invalidation signals
			// (#messageDiff / #invalidate), not raw events. When any frame
			// arrives, poll the getEvents endpoint for new events since our
			// last-seen cursor.
			try {
				const params: Record<string, string> = { streamDid: spaceDid };
				if (currentCursor !== undefined) {
					params.cursor = String(currentCursor);
				}
				const result = await this.#xrpc.query(
					"space.roomy.sync.getEvents",
					params,
				);

				// Advance cursor first so a failing callback doesn't create a
				// redelivery loop — the events are still in the DB and will be
				// re-fetched on the next poll if the cursor didn't advance.
				currentCursor = result.cursor;
				this.#repo.setSpaceCursor(spaceDid, result.cursor);

				for (const raw of result.events) {
					// Decode the CBOR payload to a plain object.
					// raw.payload is { $bytes: "base64string" } — convert to
					// Uint8Array first, then decode the CBOR.
					const payloadBytes = fromBytes(raw.payload);
					const decoded = decode(payloadBytes);
					// decoded is unknown; validate it's an object with $type
					// before passing to the callback.
					if (
						decoded &&
						typeof decoded === "object" &&
						"$type" in decoded
					) {
						// Wrap each callback invocation so a single failing
						// handler doesn't block the rest of the batch.
						try {
							await callback(decoded as Event, {
								spaceDid,
								isBackfill: false,
								userDid: raw.user,
							});
						} catch (cbErr) {
							log.error(
								`Event callback failed for ${spaceDid} idx ${raw.idx}: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
							);
						}
					}
				}
			} catch (err) {
				log.error(
					`Failed to poll events for ${spaceDid}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		});

		// Open the WebSocket connection. Must be called after subscribe() so
		// the topic is registered before the socket opens (the connect()
		// method replays tracked subscriptions on open).
		await connection.connect();

		this.#connections.set(spaceDid, connection);
		this.#subscriptions.add(spaceDid);
		log.info(
			`Subscribed to events from ${spaceDid}` +
				(currentCursor !== undefined
					? ` (resuming from idx ${currentCursor + 1})`
					: " (full backfill)"),
		);
	}
	async unsubscribe(spaceDid: string): Promise<void> {
		if (!this.#subscriptions.has(spaceDid)) return;

		const connection = this.#connections.get(spaceDid);
		if (connection) {
			connection.close();
		}
		this.#connections.delete(spaceDid);
		this.#subscriptions.delete(spaceDid);
		log.info(`Unsubscribed from ${spaceDid}`);
	}

	async disconnectAll(): Promise<void> {
		for (const [did, conn] of this.#connections) {
			conn.close();
		}
		this.#connections.clear();
		this.#subscriptions.clear();
		await this.#spaceManager.disconnectAll();
	}
}
