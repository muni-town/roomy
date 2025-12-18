/**
 * Reaction events: create, delete (including bridged variants)
 */

import { didUser, type, ulid } from "../primitives";

// Create a reaction
export const reactionCreate = type({
  $type: "'space.roomy.reaction.create.v0'",
  /** The message being reacted to */
  target: ulid,
  /** Unicode emoji or URI describing the reaction */
  reaction: "string",
});

// Delete a reaction
export const reactionDelete = type({
  $type: "'space.roomy.reaction.delete.v0'",
  /** The message the reaction was on */
  target: ulid,
  /** The reaction being removed */
  reaction: "string",
});

// Bridged reaction create (for external platforms like Discord)
export const reactionBridgedCreate = type({
  $type: "'space.roomy.reaction.bridged.create.v0'",
  /** The message being reacted to */
  target: ulid,
  /** Unicode emoji or URI describing the reaction */
  reaction: "string",
  /** The external user ID doing the reacting */
  reactingUser: didUser,
});

// Bridged reaction delete
export const reactionBridgedDelete = type({
  $type: "'space.roomy.reaction.bridged.delete.v0'",
  /** The message the reaction was on */
  target: ulid,
  /** The reaction being removed */
  reaction: "string",
  /** The external user ID whose reaction is being removed */
  reactingUser: didUser,
});

// All reaction events
export const reactionEvent = reactionCreate
  .or(reactionDelete)
  .or(reactionBridgedCreate)
  .or(reactionBridgedDelete);

// Export for registry
export const events = {
  "space.roomy.reaction.create.v0": {
    type: reactionCreate,
    description: "Create a reaction to a message",
  },
  "space.roomy.reaction.delete.v0": {
    type: reactionDelete,
    description: "Delete a reaction from a message",
  },
  "space.roomy.reaction.bridged.create.v0": {
    type: reactionBridgedCreate,
    description: "Create a bridged reaction (from external platform)",
  },
  "space.roomy.reaction.bridged.delete.v0": {
    type: reactionBridgedDelete,
    description: "Delete a bridged reaction",
  },
} as const;
