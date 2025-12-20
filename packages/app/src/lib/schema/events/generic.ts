/**
 * Info events: update name, avatar, description for entities
 *
 * These use a "set or ignore" pattern - each field can either
 * be set to a new value (including null to clear) or ignored.
 */

import { type, SetProperty } from "../primitives";

// Set entity info (rooms, spaces, etc.)
export const infoSet = type({
  $type: "'space.roomy.common.setInfo.v0'",
  /** New name, or clear, or ignore */
  "name": SetProperty,
  /** New avatar URI, or clear, or ignore */
  "avatar": SetProperty,
  /** New description, or clear, or ignore */
  "description": SetProperty,
});

// All generic events
export const genericEvent = infoSet;

// Export for registry
export const events = {
  "space.roomy.common.setInfo.v0": {
    type: infoSet,
    description: "Set name, avatar, and/or description for an entity",
  },
} as const;
