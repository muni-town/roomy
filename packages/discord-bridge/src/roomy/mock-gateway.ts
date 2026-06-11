/**
 * MockRoomyGateway: in-memory event capture for tests.
 *
 * Records all events in a per-space map. No vi.fn() needed —
 * pure in-memory, easy to assert against.
 */

import type { Event } from "@roomy-space/sdk";
import type { RoomyGateway } from "./gateway.ts";

export class MockRoomyGateway implements RoomyGateway {
	#events = new Map<string, Event[]>();

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

	async disconnectAll(): Promise<void> {
		this.#events.clear();
	}

	/** Get all events sent to a given space. */
	eventsFor(spaceDid: string): Event[] {
		return this.#events.get(spaceDid) ?? [];
	}

	/** Find the first event of a given type for a space. */
	findEvent(spaceDid: string, $type: string): Event | undefined {
		return this.eventsFor(spaceDid).find((e) => e.$type === $type);
	}

	/** Assert that a space received an event of a given type. */
	expectEvent(spaceDid: string, $type: string): Event {
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
