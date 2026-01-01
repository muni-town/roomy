/**
 * Event envelope: the outer wrapper for all events.
 *
 * This contains the common fields that every event has,
 * with the specific event data discriminated by $type.
 */

import { type, Ulid } from "./primitives";
import { MessageEvent } from "./events/message";
import { RoomEvent } from "./events/room";
import { ReactionEvent } from "./events/reaction";
import { SpaceEvent } from "./events/space";
import { PageEvent } from "./events/page";
import { UserEvent } from "./events/user";

// Add new event families here as they're defined
export const EventVariant = type.or(
  MessageEvent,
  RoomEvent,
  ReactionEvent,
  SpaceEvent,
  PageEvent,
  UserEvent,
);

// The full event envelope
// This is what gets encoded to DRISL and sent over the wire
export const Event = type({
  id: Ulid.describe("Unique event ID, also encodes timestamp"),
  "room?": Ulid.describe(
    "Parent room. This is not set for space-level events.",
  ),
  "after?": Ulid.describe(
    "Sort this event after a specific event in the room. \
If not specified, or if the ID in `after` does not exist, then the event \
will be sorted at the end of the room. \
Note: Some materializers will wait to materialize the event until the event \
specified in `after` is found, so if it does not exist, this event may not be \
materialized. \
Additionally the sort order doesn't have any effect on many events, \
but it is useful for events that create new entities in a room and where the items in the room \
are displayed in a specific order.",
  ),
  variant: EventVariant,
}).describe("Roomy's top-level event schema.");

// Type exports for TypeScript consumers

/** NSID $type key specifying an event variant */
export type EventType = (typeof EventVariant.infer)["$type"];

/** Event envelope with room, id and variant. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type Event<K = undefined> = K extends EventType
  ? Omit<typeof Event.infer, "variant"> & {
      variant: Extract<EventVariant, { $type: K }>;
    }
  : typeof Event.infer;

/** The inner data inside an event envelope. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type EventVariant<K = undefined> = K extends EventType
  ? Extract<EventVariant, { $type: K }>
  : typeof EventVariant.infer;

/**
 * Parse an event variant by looking up its $type.
 *
 * Usage:
 * ```ts
 * const decoded = drisl.decode(bytes);
 * const result = parseEvent(decoded);
 * if (result.success) {
 *   // result.data is fully typed
 * }
 * ```
 */
export function parseEvent(data: unknown) {
  const result = Event(data);
  if (result instanceof type.errors) {
    return { success: false as const, error: result.summary };
  }
  return { success: true as const, data: result };
}
