/**
 * Reaction events: add, remove (including bridged variants)
 */

import { UserDid, type, Ulid } from "../primitives";

export const AddReaction = type({
  $type: "'space.roomy.reaction.addReaction.v0'",
  target: Ulid.describe("The ID of the event being reacted to."),
  reaction: type.string.describe(
    "Unicode emoji or URI describing the reaction.",
  ),
}).describe("Add a reaction.");

export const RemoveReaction = type({
  $type: "'space.roomy.reaction.removeReaction.v0'",
  target: Ulid.describe("The ID of the event being reacted to."),
  // TODO: should this just be the reaction that we are undoing, or should that be included
  // additionally?
  previous: Ulid.describe("The ID of the addReaction event to undo."),
}).describe("Remove a reaction.");

export const AddBrigedReaction = type({
  $type: "'space.roomy.reaction.addBridgedReaction.v0'",
  target: Ulid.describe("The ID of the event being reacted to."),
  reaction: type.string.describe(
    "Unicode emoji or URI describing the reaction.",
  ),
  reactingUser: UserDid.describe("The external user ID doing the reacting"),
}).describe(
  "Add a reaction from another user. \
This is used for bridging reactions from other platforms.",
);

export const RemoveBrigedReaction = type({
  $type: "'space.roomy.reaction.removeBridgedReaction.v0'",
  target: Ulid.describe("The ID of the event being reacted to."),
  // TODO: should this just be the reaction that we are undoing, or should that be included
  // additionally?
  previous: Ulid.describe("The ID of the addBridgedReaction event to undo."),
  reactingUser: UserDid.describe("The external user ID doing the reacting"),
}).describe(
  "Remove a reaction from another user. \
This is used for bridging reactions from other platforms.",
);

// All reaction events
export const ReactionEvent = type.or(
  AddReaction,
  RemoveReaction,
  AddBrigedReaction,
  RemoveBrigedReaction,
);
