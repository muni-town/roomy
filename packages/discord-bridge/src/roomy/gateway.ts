/**
 * RoomyGateway: abstraction over sending events to Roomy spaces.
 *
 * Decouples service logic from the SpaceManager's concrete network I/O,
 * enabling tests to use an in-memory mock.
 */

import type { Event } from "@roomy-space/sdk";

export interface RoomyGateway {
	/** Send a single event to a space. */
	sendEvent(spaceDid: string, event: Event): Promise<void>;

	/** Send multiple events atomically to a space. */
	sendEvents(spaceDid: string, events: Event[]): Promise<void>;

	/** Disconnect from all connected spaces. */
	disconnectAll(): Promise<void>;
}
