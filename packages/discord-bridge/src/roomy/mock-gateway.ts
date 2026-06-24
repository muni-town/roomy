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
import type { RoomyEventCallback, RoomyGateway } from "./gateway.ts";

export class MockRoomyGateway implements RoomyGateway {
	#events = new Map<string, Event[]>();
	#subscriptions = new Map<string, RoomyEventCallback>();

	async sendEvent(spaceDid: string, event: Event): Promise<void> {
		const list = this.#events.get(spaceDid) ?? [];
		list.push(event);
		this.#events.set(spaceDid, list);
	}

	async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
		const list = this.#events.get(spaceDid) ?? [];
		list.push(...events);
		this.#events.set(spaceDid, list);
	}

	async subscribe(
		spaceDid: string,
		callback: RoomyEventCallback,
	): Promise<void> {
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
