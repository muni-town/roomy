/**
 * MockRoomyGateway: in-memory event capture for tests.
 *
 * Records all events in a per-space map. No vi.fn() needed —
 * pure in-memory, easy to assert against.
 *
 * Also supports subscribe/unsubscribe for testing the Roomy→Discord
 * direction. Use fireEvent() to simulate incoming events.
 */

import type { Event } from "@roomy-space/sdk";
import type {
	BridgeSidebar,
	BridgeSidebarCategory,
	RoomyEventCallback,
	RoomyGateway,
	RoomyRoomMessage,
	RoomyRoomMessagePage,
} from "./gateway.ts";

export class MockRoomyGateway implements RoomyGateway {
	#events = new Map<string, Event[]>();
	#subscriptions = new Map<string, RoomyEventCallback>();
	#sidebars = new Map<string, BridgeSidebar>();
	/** Room history as `getRoomMessages` sees it: newest message first. */
	#roomMessages = new Map<string, RoomyRoomMessage[]>();
	#failure: {
		count: number;
		$type: Event["$type"] | null;
		error: Error;
	} | null = null;
	#subscribeFailure: { count: number; error: Error } | null = null;
	#subscribeAttempts = 0;

	/**
	 * Make the send methods reject, as a degraded appserver does when an XRPC
	 * send times out. Affects every later call unless `count` is given, and
	 * only sends carrying an event of `$type` unless it is omitted.
	 */
	failSends(
		opts: { count?: number; $type?: Event["$type"]; error?: Error } = {},
	): void {
		this.#failure = {
			count: opts.count ?? Number.POSITIVE_INFINITY,
			$type: opts.$type ?? null,
			error:
				opts.error ??
				new Error("XRPC space.roomy.space.sendEvents timed out after 20000ms"),
		};
	}

	async sendEvent(spaceDid: string, event: Event): Promise<void> {
		await this.sendEvents(spaceDid, [event]);
	}

	async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
		const failure = this.#failure;
		if (
			failure &&
			failure.count > 0 &&
			(!failure.$type || events.some((event) => event.$type === failure.$type))
		) {
			failure.count--;
			throw failure.error;
		}
		const list = this.#events.get(spaceDid) ?? [];
		list.push(...events);
		this.#events.set(spaceDid, list);
	}

	/** Seed the sidebar a space will report from `getSidebar`. */
	setSidebar(spaceDid: string, categories: BridgeSidebarCategory[]): void {
		this.#sidebars.set(spaceDid, { categories });
	}

	/** Seed the history `getRoomMessages` pages over, newest message first. */
	seedRoomMessages(roomId: string, messages: RoomyRoomMessage[]): void {
		this.#roomMessages.set(roomId, messages);
	}

	/**
	 * Page over the seeded history. The cursor is the id of the oldest
	 * message of the previous page — opaque to callers, like the appserver's.
	 */
	async getRoomMessages(
		roomId: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<RoomyRoomMessagePage> {
		const all = this.#roomMessages.get(roomId) ?? [];
		const limit = Math.max(1, Math.floor(opts.limit ?? 100));
		let start = 0;
		if (opts.cursor !== undefined) {
			const idx = all.findIndex((m) => m.id === opts.cursor);
			start = idx === -1 ? all.length : idx + 1;
		}
		const messages = all.slice(start, start + limit);
		const last = messages.at(-1);
		return {
			messages,
			...(last !== undefined && start + messages.length < all.length
				? { cursor: last.id }
				: {}),
		};
	}

	async getSidebar(spaceDid: string): Promise<BridgeSidebar> {
		return this.#sidebars.get(spaceDid) ?? { categories: [] };
	}

	/**
	 * Make `subscribe` reject for the next `count` attempts (every later call
	 * unless `count` is given), as an unreachable appserver does when the
	 * connection-ticket fetch fails.
	 */
	failSubscribes(opts: { count?: number; error?: Error } = {}): void {
		this.#subscribeFailure = {
			count: opts.count ?? Number.POSITIVE_INFINITY,
			error:
				opts.error ??
				new Error(
					"XRPC space.roomy.auth.getConnectionTicket failed (404): Application not found",
				),
		};
	}

	/** Total subscribe attempts, successful or not. */
	get subscribeAttempts(): number {
		return this.#subscribeAttempts;
	}

	async subscribe(
		spaceDid: string,
		callback: RoomyEventCallback,
	): Promise<void> {
		this.#subscribeAttempts++;
		const failure = this.#subscribeFailure;
		if (failure && failure.count > 0) {
			failure.count--;
			throw failure.error;
		}
		if (this.#subscriptions.has(spaceDid)) {
			throw new Error(`Already subscribed to ${spaceDid}`);
		}
		this.#subscriptions.set(spaceDid, callback);
	}

	async unsubscribe(spaceDid: string): Promise<void> {
		this.#subscriptions.delete(spaceDid);
	}

	async disconnectAll(): Promise<void> {
		this.#events.clear();
		this.#subscriptions.clear();
	}

	/** Simulate an incoming event from a Roomy space. */
	async fireEvent(
		spaceDid: string,
		event: Event,
		isBackfill = false,
		userDid = "did:plc:test-user",
	): Promise<void> {
		const callback = this.#subscriptions.get(spaceDid);
		if (callback) {
			await callback(event, { spaceDid, isBackfill, userDid });
		}
	}

	/** Get all events sent to a given space. */
	eventsFor(spaceDid: string): Event[] {
		return this.#events.get(spaceDid) ?? [];
	}

	/** Find the first event of a given type for a space. */
	findEvent<T extends Event["$type"]>(
		spaceDid: string,
		$type: T,
	): Extract<Event, { $type: T }> | undefined {
		return this.eventsFor(spaceDid).find(
			(e): e is Extract<Event, { $type: typeof $type }> => e.$type === $type,
		);
	}

	/** Assert that a space received an event of a given type. */
	expectEvent<T extends Event["$type"]>(spaceDid: string, $type: T): Event {
		const evt = this.findEvent(spaceDid, $type);
		if (!evt) {
			const types = this.eventsFor(spaceDid)
				.map((e) => e.$type)
				.join(", ");
			throw new Error(
				`Expected event ${$type} for ${spaceDid}, got: [${types}]`,
			);
		}
		return evt;
	}

	/** Count of events sent to a given space. */
	eventCount(spaceDid: string): number {
		return this.eventsFor(spaceDid).length;
	}

	/** Reset all captured events. */
	reset(): void {
		this.#events.clear();
	}
}
