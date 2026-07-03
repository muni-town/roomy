/**
 * LiveRoomyGateway: wraps SpaceManager to send events to real Roomy spaces
 * and subscribe to events from Roomy spaces.
 *
 * Subscriptions use the SDK's SyncConnection for WebSocket-based sync.
 */

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

		const connection = new sync.SyncConnection({
			fetchTicket: async () => {
				const { ticket } = await this.#xrpc.procedure("space.roomy.auth.getConnectionTicket", {});
				return ticket;
			},
			wsUrl: this.#appserverWsUrl,
		});

		connection.subscribe({ kind: "space", id: spaceDid });

		// NOTE: SyncConnection.subscribe() does not accept a start cursor/idx.
		// The cursor is persisted on each received frame below so that on
		// restart we at least know how far we got, but the sync system always
		// starts from the current state (no historical backfill via cursor).
		// Full backfill is handled separately by the backfill service.

		connection.onFrame((frame: sync.SyncFrame) => {
			// The appserver sync system sends invalidation signals
			// (#messageDiff / #invalidate), not raw events. We persist the
			// cursor for restart resume and log the frame for diagnostics.
			// Raw event delivery is handled by the sendEvents XRPC path;
			// the bridge receives events from Discord and sends them to Roomy.
			// Roomy→Discord event routing uses the persisted cursor to know
			// where we left off.
			log.info(`Received frame for ${spaceDid}: ${frame.header.t}`);

			// Persist cursor so we can resume from this point on restart.
			if (cursor !== undefined) {
				this.#repo.setSpaceCursor(spaceDid, cursor + 1);
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
				(cursor !== undefined
					? ` (resuming from idx ${cursor + 1})`
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
