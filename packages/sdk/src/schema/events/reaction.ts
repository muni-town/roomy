/**
 * Reaction events: add, remove (including bridged variants)
 */

import { sql } from "../../utils";
import { UserDid, type, Ulid } from "../primitives";
import { defineEvent, ensureEntity } from "./utils";

const AddReactionSchema = type({
  $type: "'space.roomy.reaction.addReaction.v0'",
  reactionTo: Ulid.describe("The ID of the event being reacted to."),
  reaction: type.string.describe(
    "Unicode emoji or URI describing the reaction.",
  ),
}).describe("Add a reaction.");

export const AddReaction = defineEvent(
  AddReactionSchema,
  ({ event, user }) => {
    return [
      sql`
        insert or replace into comp_reaction (entity, user, reaction, reaction_id)
        values (
          ${event.reactionTo},
          ${user},
          ${event.reaction},
          ${event.id}
        )
      `,
    ];
  },
  (x) => [x.reactionTo],
);

const RemoveReactionSchema = type({
  $type: "'space.roomy.reaction.removeReaction.v0'",
  reactionId: Ulid.describe("The ID of the addReaction event to undo."),
}).describe("Remove a reaction.");

export const RemoveReaction = defineEvent(
  RemoveReactionSchema,
  ({ event }) => {
    if (!event.room) {
      console.warn("Delete reaction missing room");
      return [];
    }
    return [
      sql`
      delete from comp_reaction
      where
        reaction_id = ${event.reactionId}
    `,
    ];
  },
  (x) => [x.reactionId],
);

const AddBridgedReactionSchema = type({
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

export const AddBridgedReaction = defineEvent(
  AddBridgedReactionSchema,
  ({ streamId, event }) => {
    // Ignore Discord custom emoji reactions (<:name:id> or <a:name:id>)
    if (/^<a?:\w+:\d+>$/.test(event.reaction)) {
      return [];
    }
    return [
      ensureEntity(streamId, event.reactingUser),
      sql`
        insert or replace into comp_reaction (entity, user, reaction, reaction_id)
        values (
          ${event.reactionTo},
          ${event.reactingUser},
          ${event.reaction},
          ${event.id}
        )
      `,
    ];
  },
  (x) => [x.reactionTo],
);

const RemoveBridgedReactionSchema = type({
  $type: "'space.roomy.reaction.removeBridgedReaction.v0'",
  reactionId: Ulid.describe("The ID of the addBridgedReaction event to undo."),
  reactingUser: UserDid.describe("The external user ID doing the reacting"),
}).describe(
  "Remove a reaction from another user. \
This is used for bridging reactions from other platforms.",
);

export const RemoveBridgedReaction = defineEvent(
  RemoveBridgedReactionSchema,
  ({ event }) => {
    if (!event.room) {
      console.warn("Delete reaction missing room");
      return [];
    }
    return [
      sql`
      delete from comp_reaction
      where
        reaction_id = ${event.reactionId}
    `,
    ];
  },
  (x) => [x.reactionId],
);

// All reaction events
export const ReactionEventVariant = type.or(
  AddReactionSchema,
  RemoveReactionSchema,
  AddBridgedReactionSchema,
  RemoveBridgedReactionSchema,
);
