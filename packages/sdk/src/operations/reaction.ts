/**
 * Reaction operations for Roomy.
 * High-level functions for adding and removing reactions.
 */

import { newUlid, type Ulid } from "../schema";
import type { Event } from "../schema";
import type { ConnectedSpace } from "../connection";

/**
 * Options for adding a reaction.
 */
export interface AddReactionOptions {
  /** The room containing the message */
  roomId: Ulid;
  /** The message to react to */
  messageId: Ulid;
  /** The reaction emoji/content */
  reaction: string;
}

/**
 * Result of adding a reaction.
 */
export interface AddReactionResult {
  /** The ID of the reaction event */
  id: Ulid;
}

/**
 * Add a reaction to a message.
 *
 * @param space - The connected space to send the event to
 * @param options - Reaction add options
 * @returns The ID of the reaction event
 *
 * @example
 * ```ts
 * const result = await addReaction(space, {
 *   roomId: "01H...",
 *   messageId: "01J...",
 *   reaction: "👍"
 * });
 * ```
 */
export async function addReaction(
  space: ConnectedSpace,
  options: AddReactionOptions,
): Promise<AddReactionResult> {
  const reactionId = newUlid();

  const event: Event = {
    id: reactionId,
    room: options.roomId,
    $type: "space.roomy.reaction.addReaction.v0",
    reactionTo: options.messageId,
    reaction: options.reaction,
  };

  await space.sendEvent(event);

  return { id: reactionId };
}

/**
 * Options for removing a reaction.
 */
export interface RemoveReactionOptions {
  /** The room containing the reaction */
  roomId: Ulid;
  /** The ID of the reaction event to remove */
  reactionId: Ulid;
}

/**
 * Result of removing a reaction.
 */
export interface RemoveReactionResult {
  /** The ID of the remove reaction event */
  id: Ulid;
}

/**
 * Remove a reaction from a message.
 *
 * @param space - The connected space to send the event to
 * @param options - Reaction remove options
 * @returns The ID of the remove reaction event
 *
 * @example
 * ```ts
 * const result = await removeReaction(space, {
 *   roomId: "01H...",
 *   reactionId: "01J..."
 * });
 * ```
 */
export async function removeReaction(
  space: ConnectedSpace,
  options: RemoveReactionOptions,
): Promise<RemoveReactionResult> {
  const removeId = newUlid();

  const event: Event = {
    id: removeId,
    room: options.roomId,
    $type: "space.roomy.reaction.removeReaction.v0",
    reactionId: options.reactionId,
  };

  await space.sendEvent(event);

  return { id: removeId };
}
