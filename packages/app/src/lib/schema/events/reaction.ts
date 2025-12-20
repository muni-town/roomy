/**
 * Reaction events: create, delete (including bridged variants)
 */

import { UserDid, type, Ulid } from "../primitives";

// Create a reaction
export const reactionCreate = type({
  $type: "'space.roomy.room.addReaction.v0'",
  /** The message being reacted to */
  target: Ulid,
  /** Unicode emoji or URI describing the reaction */
  reaction: "string",
});

// Delete a reaction
export const reactionDelete = type({
  $type: "'space.roomy.room.removeReaction.v0'",
  /** The message the reaction was on */
  target: Ulid,
  /** The reaction being removed */
  reaction: "string",
});

// Bridged reaction create (for external platforms like Discord)
export const reactionBridgedCreate = type({
  $type: "'space.roomy.room.addBridgedReaction.v0'",
  /** The message being reacted to */
  target: Ulid,
  /** Unicode emoji or URI describing the reaction */
  reaction: "string",
  /** The external user ID doing the reacting */
  reactingUser: UserDid,
});

// Bridged reaction delete
export const reactionBridgedDelete = type({
  $type: "'space.roomy.room.removeBridgedReaction.v0'",
  /** The message the reaction was on */
  target: Ulid,
  /** The reaction being removed */
  reaction: "string",
  /** The external user ID whose reaction is being removed */
  reactingUser: UserDid,
});

// All reaction events
export const reactionEvent = reactionCreate
  .or(reactionDelete)
  .or(reactionBridgedCreate)
  .or(reactionBridgedDelete);

// Export for registry
export const events = {
  "space.roomy.room.addReaction.v0": {
    type: reactionCreate,
    description: "Create a reaction to a message",
  },
  "space.roomy.room.removeReaction.v0": {
    type: reactionDelete,
    description: "Delete a reaction from a message",
  },
  "space.roomy.room.addBridgedReaction.v0": {
    type: reactionBridgedCreate,
    description: "Create a bridged reaction (from external platform)",
  },
  "space.roomy.room.removeBridgedReaction.v0": {
    type: reactionBridgedDelete,
    description: "Delete a bridged reaction",
  },
} as const;
