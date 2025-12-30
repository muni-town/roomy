import { type } from "../primitives";
import { DeleteMessage, EditMessage } from "./message";
import {
  AddReaction,
  AddBrigedReaction,
  RemoveReaction,
  RemoveBrigedReaction,
} from "./reaction";
import { EditPage } from "./page";

export const WithParent = type.or(
  EditMessage,
  RemoveReaction,
  RemoveBrigedReaction,
  EditPage,
);

export const WithTarget = type.or(
  DeleteMessage,
  AddReaction,
  AddBrigedReaction,
);

/** Union of all event variants that *depend* on previous events.
 * These must not be applied until the parent, or target, has been applied.
 */
export const DependentEventVariant = type.or(WithParent, WithTarget);

export type DependentEventVariant = typeof DependentEventVariant.infer;
export type DependentEventType = DependentEventVariant["$type"];

export const dependentEventType: DependentEventType[] = [
  "space.roomy.message.editMessage.v0",
  "space.roomy.page.editPage.v0",
  "space.roomy.message.deleteMessage.v0",
  "space.roomy.reaction.addReaction.v0",
  "space.roomy.reaction.addBridgedReaction.v0",
  "space.roomy.reaction.removeReaction.v0",
  "space.roomy.reaction.removeBridgedReaction.v0",
];
