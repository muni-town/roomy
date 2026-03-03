/**
 * State events: update mutable state in the state database
 *
 * State events are NOT persisted to the stream. They update the state DB directly.
 * This allows for mutable, user-specific data like read receipts.
 */

import { type, Ulid } from "../primitives";
import { defineEvent } from "./utils";

const MarkReadSchema = type({
  $type: "'space.roomy.state.markRead.v0'",
  room: Ulid.describe(
    "The room that has been read up to the current message count.",
  ),
}).describe(
  "Mark a room as read. \
This state event updates the user's read position to the current message count for the room. \
State events are not persisted to the stream - they only update the state database.",
);

export const MarkRead = defineEvent(MarkReadSchema, ({ event }) => {
  // The actual work is done by the module's state materializer
  // which queries the current message_count and updates the reads table
  return [];
});

// All state events
export const StateEventVariant = type.or(MarkReadSchema);
