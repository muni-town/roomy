/**
 * Event envelope: the outer wrapper for all events.
 *
 * This contains the common fields that every event has,
 * with the specific event data discriminated by $type.
 */

import { type, ulid } from "./primitives";
import { messageEvent } from "./events/message";
import { roomEvent } from "./events/room";
import { reactionEvent } from "./events/reaction";
import { spaceEvent } from "./events/space";
import { genericEvent } from "./events/generic";
import { pageEvent } from "./events/page";
import { userEvent } from "./events/user";

// Union of all event variants
// Add new event families here as they're defined
export const eventVariant = type.or(
  messageEvent,
  roomEvent,
  reactionEvent,
  spaceEvent,
  genericEvent,
  pageEvent,
  userEvent,
);

// The full event envelope
// This is what gets encoded to DRISL and sent over the wire
export const event = type({
  /** Unique event ID, also encodes timestamp */
  id: ulid,
  /** Parent room. Null for space-level events. */
  "room?": ulid,
  /** The event payload (discriminated by $type) */
  variant: eventVariant,
});

// Type exports for TypeScript consumers

/** NSID $type key specifying an event variant */
export type EventType = (typeof eventVariant.infer)["$type"];

/** Event envelope with room, id and variant. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type Event<K = undefined> = K extends EventType
  ? Omit<Event, "variant"> & {
      variant: Extract<EventVariant, { $type: K }>;
    }
  : typeof event.infer;

/** The inner data inside an event envelope. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type EventVariant<K = undefined> = K extends EventType
  ? Extract<EventVariant, { $type: K }>
  : typeof eventVariant.infer;

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
  const result = event(data);
  if (result instanceof type.errors) {
    return { success: false as const, error: result.summary };
  }
  return { success: true as const, data: result };
}
