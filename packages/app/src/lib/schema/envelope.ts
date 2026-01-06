/**
 * Event envelope: the outer wrapper for all events.
 *
 * This contains the common fields that every event has,
 * with the specific event data discriminated by $type.
 */

import { type, Ulid } from "./primitives";
import { MessageEventVariant } from "./events/message";
import { RoomEventVariant } from "./events/room";
import { ReactionEventVariant } from "./events/reaction";
import { SpaceEventVariant } from "./events/space";
import { PageEventVariant } from "./events/page";
import { UserEventVariant } from "./events/user";
import { LinkEventVariant } from "./events/link";

/** Any event variant that is sent in a room */
export const RoomEventVariantUnion = type.or(
  MessageEventVariant,
  ReactionEventVariant,
  PageEventVariant,
  LinkEventVariant,
);

/** Any event variant that is sent in the top level of a space */
export const SpaceEventVariantUnion = type.or(
  SpaceEventVariant,
  RoomEventVariant,
  UserEventVariant,
);

/** Any event variant */
export const EventVariant = RoomEventVariantUnion.or(SpaceEventVariantUnion);

/** Any event that is sent in a Roomy room.  */
export const RoomEvent = type({
  id: Ulid.describe("Unique event ID, also encodes timestamp"),
  room: Ulid.describe("Parent room."),
  variant: RoomEventVariantUnion,
}).describe("Any event that is sent in a Roomy room.");

/** Any event that is sent in the top level of a Roomy space. */
export const SpaceEvent = type({
  id: Ulid.describe("Unique event ID, also encodes timestamp"),
  variant: SpaceEventVariantUnion,
}).describe("Any event that is sent in the top level of a Roomy space.");

/** The full event envelope
 * This is what gets encoded to DRISL and sent over the wire  */
export const Event = RoomEvent.or(SpaceEvent);

// Type exports for TypeScript consumers

/** NSID $type key specifying a room event variant */
export type RoomEventType = (typeof RoomEventVariantUnion.infer)["$type"];

/** NSID $type key specifying a space event variant */
export type SpaceEventType = (typeof SpaceEventVariantUnion.infer)["$type"];

/** NSID $type key specifying any Roomy event variant */
export type EventType = RoomEventType | SpaceEventType;

/** The inner data inside a room event envelope. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type RoomEventVariantUnion<K = undefined> = K extends RoomEventType
  ? Extract<typeof RoomEventVariantUnion.infer, { $type: K }>
  : typeof RoomEventVariantUnion.infer;

/** The inner data inside a space event envelope. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type SpaceEventVariantUnion<K = undefined> = K extends SpaceEventType
  ? Extract<typeof SpaceEventVariantUnion.infer, { $type: K }>
  : typeof SpaceEventVariantUnion.infer;

export type EventVariant<K = undefined> = K extends RoomEventType
  ? RoomEventVariantUnion<K>
  : K extends SpaceEventType
    ? SpaceEventVariantUnion<K>
    : RoomEventVariantUnion | SpaceEventVariantUnion;

/** Room event envelope with room, id and variant. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type RoomEvent<K = undefined> = K extends RoomEventType
  ? Omit<typeof RoomEvent.infer, "variant"> & {
      variant: Extract<typeof RoomEventVariantUnion.infer, { $type: K }>;
    }
  : typeof RoomEvent.infer;

/** Space event envelope with room, id and variant. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type SpaceEvent<K = undefined> = K extends SpaceEventType
  ? Omit<typeof SpaceEvent.infer, "variant"> & {
      variant: Extract<typeof SpaceEventVariantUnion.infer, { $type: K }>;
    }
  : typeof SpaceEvent.infer;

/** Event envelope with id, room (if room event) and variant. Optionally accepts an EventType parameter,
 * which narrows to the given event type */
export type Event<K = undefined> = K extends RoomEventType
  ? RoomEvent<K>
  : K extends SpaceEventType
    ? SpaceEvent<K>
    : RoomEvent | SpaceEvent;

/**
 * Parse a room event variant by looking up its $type.
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
