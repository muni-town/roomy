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
  room: ulid,
  /** The event payload (discriminated by $type) */
  event: eventVariant,
});

// Type exports for TypeScript consumers
export type EventVariant = typeof eventVariant.infer;
export type Event = typeof event.infer;
