/**
 * Info events: update name, avatar, description for entities
 *
 * These use a "set or ignore" pattern - each field can either
 * be set to a new value (including null to clear) or ignored.
 */

import { type, setProperty } from "../primitives";

// Set entity info (rooms, spaces, etc.)
export const infoSet = type({
  $type: "'space.roomy.info.set.v0'",
  /** New name, or clear, or ignore */
  "name?": setProperty,
  /** New avatar URI, or clear, or ignore */
  "avatar?": setProperty,
  /** New description, or clear, or ignore */
  "description?": setProperty,
});

// All generic events
export const genericEvent = infoSet;

// Export for registry
export const events = {
  "space.roomy.info.set.v0": {
    type: infoSet,
    description: "Set name, avatar, and/or description for an entity",
  },
} as const;
