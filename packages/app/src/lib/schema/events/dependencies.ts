import { type } from "../primitives";
import { messageDelete, messageEdit, messageOverrideMeta } from "./message";
import {
  reactionAdd,
  reactionBridgedAdd,
  reactionBridgedRemove,
  reactionRemove,
} from "./reaction";
import { pageEdit } from "./page";

export const WithParent = type.or(
  messageEdit,
  reactionRemove,
  reactionBridgedRemove,
  pageEdit,
);

export const WithTarget = type.or(
  messageDelete,
  messageOverrideMeta,
  reactionAdd,
  reactionBridgedAdd,
);

/** Union of all event variants that *depend* on previous events.
 * These must not be applied until the parent, or target, has been applied.
 */
export const DependentEventVariant = type.or(WithParent, WithTarget);

export type DependentEventVariant = typeof DependentEventVariant.infer;
export type DependentEventType = DependentEventVariant["$type"];

export const dependentEventType: DependentEventType[] = [
  "space.roomy.room.editMessage.v0",
  "space.roomy.room.editPage.v0",
  "space.roomy.room.deleteMessage.v0",
  "space.roomy.room.overrideMessageMeta.v0",
  "space.roomy.room.addReaction.v0",
  "space.roomy.room.addBridgedReaction.v0",
  "space.roomy.room.removeReaction.v0",
  "space.roomy.room.removeBridgedReaction.v0",
];
