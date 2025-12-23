/**
 * Reaction events: add, remove (including bridged variants)
 */

import { UserDid, type, Ulid } from "../primitives";

// Add a reaction
export const reactionAdd = type({
  $type: "'space.roomy.room.addReaction.v0'",
  /** The message being reacted to */
  target: Ulid,
  /** Unicode emoji or URI describing the reaction */
  reaction: "string",
});

// Remove a reaction
export const reactionRemove = type({
  $type: "'space.roomy.room.removeReaction.v0'",
  /** The message the reaction was on */
  target: Ulid,
  /** The addReaction event */
  "previous?": Ulid,
});

// Bridged reaction add (for external platforms like Discord)
export const reactionBridgedAdd = type({
  $type: "'space.roomy.room.addBridgedReaction.v0'",
  /** The message being reacted to */
  target: Ulid,
  /** Unicode emoji or URI describing the reaction */
  reaction: "string",
  /** The external user ID doing the reacting */
  reactingUser: UserDid,
});

// Bridged reaction remove
export const reactionBridgedRemove = type({
  $type: "'space.roomy.room.removeBridgedReaction.v0'",
  /** The message the reaction was on */
  target: Ulid,
  /** The addBridgedReaction event */
  "previous?": Ulid,
  /** The external user ID whose reaction is being removed */
  reactingUser: UserDid,
});

// All reaction events
export const reactionEvent = reactionAdd
  .or(reactionRemove)
  .or(reactionBridgedAdd)
  .or(reactionBridgedRemove);

// Export for registry
export const events = {
  "space.roomy.room.addReaction.v0": {
    type: reactionAdd,
    description: "Add a reaction to a message",
  },
  "space.roomy.room.removeReaction.v0": {
    type: reactionRemove,
    description: "Remove a reaction from a message",
  },
  "space.roomy.room.addBridgedReaction.v0": {
    type: reactionBridgedAdd,
    description: "Add a bridged reaction (from external platform)",
  },
  "space.roomy.room.removeBridgedReaction.v0": {
    type: reactionBridgedRemove,
    description: "Remove a bridged reaction",
  },
} as const;
