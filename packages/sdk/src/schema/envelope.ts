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
export type RoomEventVariantUnion = typeof RoomEventVariantUnion.infer;

/** Any event variant that is sent in the top level of a space */
export const SpaceEventVariantUnion = type.or(
  SpaceEventVariant,
  RoomEventVariant,
  UserEventVariant,
);

/** Any event that is sent in a Roomy room.  */
export const RoomEvent = RoomEventVariantUnion.and(
  type({ room: Ulid.describe("The room that this event is sent in.") }),
);

/** Any event that is sent in the top level of a Roomy space. */
export const SpaceEvent = SpaceEventVariantUnion;

/** Any event variant */
export const Event = type.or(RoomEvent, SpaceEvent).and(
  type({
    id: Ulid.describe(
      "Unique event ULID. A ULID is both globally unique and also contains timestamp information",
    ),
  }),
);

/** NSID $type key specifying a room event variant */
export type RoomEventType = (typeof RoomEventVariantUnion.infer)["$type"];

/** NSID $type key specifying a space event variant */
export type SpaceEventType = (typeof SpaceEventVariantUnion.infer)["$type"];

/** NSID $type key specifying any Roomy event variant */
export type EventType = RoomEventType | SpaceEventType;

/** A Roomy event. Optionally accepts an EventType parameter, which narrows to the given event type
 * */
export type Event<K = undefined> = K extends EventType
  ? Extract<typeof Event.infer, { $type: K }>
  : typeof Event.infer;

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
