/**
 * LiveRoomyGateway: wraps SpaceManager to send events to real Roomy spaces
 * and subscribe to events from Roomy spaces.
 *
 * Subscriptions use a persistent per-space cursor (stored in the
 * BridgeRepository) so that restarts resume from the last-seen stream
 * index instead of re-backfilling the entire space history.
 */

import { type Event, StreamIndex } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import { createLogger } from "../logger.ts";
import type { RoomyEventCallback, RoomyGateway } from "./gateway.ts";
import type { SpaceManager } from "./space-manager.ts";

const log = createLogger("live-roomy");

export class LiveRoomyGateway implements RoomyGateway {
	#spaceManager: SpaceManager;
	#repo: BridgeRepository;
	/** Track active subscriptions per space so we can unsubscribe. */
	#subscriptions = new Set<string>();
	/** Per-space processing chain — ensures batches are processed sequentially. */
	#processing = new Map<string, Promise<void>>();
	/** Per-space cursor freeze — once an event fails, the cursor is frozen
	 *  at the last successful position until the process restarts. */
	#cursorFrozen = new Set<string>();

	constructor(spaceManager: SpaceManager, repo: BridgeRepository) {
		this.#spaceManager = spaceManager;
		this.#repo = repo;
	}

	async sendEvent(spaceDid: string, event: Event): Promise<void> {
		const connected = await this.#spaceManager.getOrConnect(spaceDid);
		await connected.sendEvent(event);
	}

	async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
		const connected = await this.#spaceManager.getOrConnect(spaceDid);
		await connected.sendEvents(events);
	}

	async subscribe(
		spaceDid: string,
		callback: RoomyEventCallback,
	): Promise<void> {
		if (this.#subscriptions.has(spaceDid)) {
			log.warn(`Already subscribed to ${spaceDid}, skipping`);
			return;
		}

		const connected = await this.#spaceManager.getOrConnect(spaceDid);

		// Resume from the persisted cursor so we don't re-backfill the entire
		// space history on every restart.  ConnectedSpace.subscribe expects a
		// 1-based start index, so we advance the cursor by +1.
		const cursor = this.#repo.getSpaceCursor(spaceDid);
		const start =
			cursor !== undefined ? StreamIndex.assert(cursor + 1) : undefined; // undefined → ConnectedSpace default (full backfill)

		await connected.subscribe((decodedEvents, meta) => {
			// Chain this batch onto any in-flight processing for this space
			// so batches are processed sequentially (not concurrently).
			const previous = this.#processing.get(spaceDid) ?? Promise.resolve();
			const current = previous
				.then(() => this.#processBatch(spaceDid, decodedEvents, meta, callback))
				.catch((err) => {
					log.error(`Error processing event batch for ${spaceDid}`, err);
				});
			this.#processing.set(spaceDid, current);
		}, start);

		this.#subscriptions.add(spaceDid);
		log.info(
			`Subscribed to events from ${spaceDid}` +
				(cursor !== undefined
					? ` (resuming from idx ${cursor + 1})`
					: " (full backfill)"),
		);
	}

	/**
	 * Process a batch of decoded events sequentially, awaiting each callback.
	 * The cursor is only advanced to the last *successfully* processed event.
	 * If an event fails, the cursor is frozen at the last success before the
	 * failure; subsequent batches continue to process (for live delivery) but
	 * the cursor doesn't advance until restart re-delivers the failed event.
	 */
	async #processBatch(
		spaceDid: string,
		decodedEvents: ReadonlyArray<{ event: Event; idx: number; user: string }>,
		meta: { isBackfill: boolean },
		callback: RoomyEventCallback,
	): Promise<void> {
		if (this.#cursorFrozen.has(spaceDid)) {
			// A previous batch had a failure — keep processing events for live
			// delivery but don't advance the cursor. On restart, events from
			// the cursor position will be re-delivered (including the failed
			// one and any processed after it). Dedup handles the redundancy.
			for (const { event, user } of decodedEvents) {
				try {
					await callback(event, { spaceDid, isBackfill: meta.isBackfill, userDid: user });
				} catch (err) {
					log.error(
						`Error in event callback for ${spaceDid} (${event.$type})`,
						err,
					);
				}
			}
			return;
		}

		let lastSuccessIdx = -1;
		let hadFailure = false;
		for (const { event, idx, user } of decodedEvents) {
			try {
				await callback(event, { spaceDid, isBackfill: meta.isBackfill, userDid: user });
				if (!hadFailure) lastSuccessIdx = idx;
			} catch (err) {
				log.error(
					`Error in event callback for ${spaceDid} (${event.$type})`,
					err,
				);
				hadFailure = true;
			}
		}

		if (hadFailure) {
			this.#cursorFrozen.add(spaceDid);
		}

		if (lastSuccessIdx >= 0) {
			try {
				this.#repo.setSpaceCursor(spaceDid, lastSuccessIdx);
			} catch (err) {
				log.error(`Failed to persist cursor for ${spaceDid}`, err);
			}
		}
	}

	async unsubscribe(spaceDid: string): Promise<void> {
		if (!this.#subscriptions.has(spaceDid)) return;

		const connected = this.#spaceManager.get(spaceDid);
		if (connected) {
			await connected.unsubscribe();
		}
		this.#subscriptions.delete(spaceDid);
		this.#cursorFrozen.delete(spaceDid);
		log.info(`Unsubscribed from ${spaceDid}`);
	}

	async disconnectAll(): Promise<void> {
		this.#subscriptions.clear();
		this.#cursorFrozen.clear();
		await this.#spaceManager.disconnectAll();
	}
}
