/**
 * Reaction events: add, remove (including bridged variants)
 */

import { UserDid, type, Ulid } from "../primitives";
import { setDependsOn } from "./dependencies";

export const AddReaction = type({
  $type: "'space.roomy.reaction.addReaction.v0'",
  reactionTo: Ulid.describe("The ID of the event being reacted to."),
  reaction: type.string.describe(
    "Unicode emoji or URI describing the reaction.",
  ),
}).describe("Add a reaction.");

setDependsOn("space.roomy.reaction.addReaction.v0", {
  events: (x) => [x.reactionTo],
});

export const RemoveReaction = type({
  $type: "'space.roomy.reaction.removeReaction.v0'",
  reactionId: Ulid.describe("The ID of the addReaction event to undo."),
}).describe("Remove a reaction.");

setDependsOn("space.roomy.reaction.removeReaction.v0", {
  events: (x) => [x.reactionId],
});

export const AddBrigedReaction = type({
  $type: "'space.roomy.reaction.addBridgedReaction.v0'",
  reactionTo: Ulid.describe("The ID of the event being reacted to."),
  reaction: type.string.describe(
    "Unicode emoji or URI describing the reaction.",
  ),
  reactingUser: UserDid.describe("The external user ID doing the reacting"),
}).describe(
  "Add a reaction from another user. \
This is used for bridging reactions from other platforms.",
);

setDependsOn("space.roomy.reaction.addBridgedReaction.v0", {
  events: (x) => [x.reactionTo],
});

export const RemoveBrigedReaction = type({
  $type: "'space.roomy.reaction.removeBridgedReaction.v0'",
  reactionId: Ulid.describe("The ID of the addBridgedReaction event to undo."),
  reactingUser: UserDid.describe("The external user ID doing the reacting"),
}).describe(
  "Remove a reaction from another user. \
This is used for bridging reactions from other platforms.",
);

setDependsOn("space.roomy.reaction.removeBridgedReaction.v0", {
  events: (x) => [x.reactionId],
});

// All reaction events
export const ReactionEvent = type.or(
  AddReaction,
  RemoveReaction,
  AddBrigedReaction,
  RemoveBrigedReaction,
);
