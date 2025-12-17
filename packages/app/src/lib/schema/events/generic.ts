/**
 * Info events: update name, avatar, description for entities
 *
 * These use a "set or ignore" pattern - each field can either
 * be set to a new value (including null to clear) or ignored.
 */

import { type, stringUpdate } from "../primitives";

/**
 * Value update wrapper - either set a value or ignore (don't change).
 *
 * In CBOR this would be represented as:
 * - { set: value } to update
 * - { ignore: null } to leave unchanged
 *
 * But for simplicity in the ArkType schema, we use optional fields
 * where presence indicates "set" and absence indicates "ignore".
 */

// Set entity info (rooms, spaces, etc.)
export const infoSet = type({
  $type: "'space.roomy.event.info.set'",
  /** New name, or undefined to not change, or null to clear */
  "name?": stringUpdate,
  /** New avatar URI, or undefined to not change, or null to clear */
  "avatar?": stringUpdate,
  /** New description, or undefined to not change, or null to clear */
  "description?": stringUpdate,
});

// All generic events
export const genericEvent = infoSet;

// Export for registry
export const events = {
  "space.roomy.event.info.set": {
    type: infoSet,
    description: "Set name, avatar, and/or description for an entity",
  },
} as const;
