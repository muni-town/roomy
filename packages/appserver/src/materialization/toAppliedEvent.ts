/**
 * Convert a decoded Leaf stream event into an AppliedEvent for the
 * invalidation router.
 *
 * Extracts event-specific fields into `details` based on `$type`, pulling
 * only what `inferSignals` actually reads. The parsed `Event` object has
 * all fields available — we just pick the ones we need.
 */

import type {
  DecodedStreamEvent,
  StreamDid,
  Ulid,
  UserDid,
} from "@roomy-space/sdk";
import type { AppliedEvent } from "../invalidation/types.ts";

/**
 * Extract event-specific details that `inferSignals` needs.
 *
 * The `event` is a discriminated union on `$type` — each branch has its
 * own fields. We read them generically here since the event has already
 * been validated by the SDK parser.
 */
function extractDetails(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const type = event["$type"] as string;

  switch (type) {
    // Message events: content, author info, reply target.
    case "space.roomy.message.createMessage.v0":
    case "space.roomy.message.editMessage.v0": {
      // Body is { mimeType, data } — we can't decode the CBOR data blob
      // cheaply here, so we omit content. The WS messageDiff will have
      // content="" for now; the client re-fetches for full content after
      // applying the diff. This is fine — message diffs are primarily for
      // the WS frame, and the full content comes from the HTTP endpoint.
      //
      // The `room` field is on the event envelope, not details.
      // Author comes from the authenticated `user` on the stream event.
      const extensions = event["extensions"] as
        | Record<string, unknown>
        | undefined;
      const authorOverride = extensions?.[
        "space.roomy.extension.authorOverride.v0"
      ] as { did?: string } | undefined;
      const timestampOverride = extensions?.[
        "space.roomy.extension.timestampOverride.v0"
      ] as { timestamp?: number } | undefined;

      return {
        authorDid: authorOverride?.did,
        timestamp:
          timestampOverride?.timestamp != null
            ? new Date(timestampOverride.timestamp).toISOString()
            : undefined,
        replyTo: undefined, // resolved from edges after materialization
      };
    }

    case "space.roomy.message.deleteMessage.v0":
      return undefined;

    case "space.roomy.message.forwardMessages.v0":
      return undefined;

    // Reaction events: which message was reacted to.
    case "space.roomy.reaction.addReaction.v0":
    case "space.roomy.reaction.removeReaction.v0":
    case "space.roomy.reaction.addBridgedReaction.v0":
    case "space.roomy.reaction.removeBridgedReaction.v0":
      return { messageId: event["reactionTo"] };

    // Room events: which room is affected.
    case "space.roomy.room.updateRoom.v0":
    case "space.roomy.room.deleteRoom.v0":
    case "space.roomy.room.restoreRoom.v0":
      return { roomId: event["roomId"] };

    // Space admin events: target user.
    case "space.roomy.space.addAdmin.v0":
    case "space.roomy.space.removeAdmin.v0":
    case "space.roomy.space.banAccount.v0":
    case "space.roomy.space.unbanAccount.v0":
      return { userDid: event["userDid"] };

    // Role events: target user and/or room.
    case "space.roomy.role.addMemberRole.v0":
    case "space.roomy.role.removeMemberRole.v0":
      return { userDid: event["userDid"] };

    case "space.roomy.role.setRoleRoomPermission.v0":
      return { roomId: event["roomId"] };

    // Personal stream events: which space was joined/left.
    case "space.roomy.space.personal.joinSpace.v0":
    case "space.roomy.space.personal.leaveSpace.v0":
      return { spaceDid: event["spaceDid"] };

    default:
      return undefined;
  }
}

/**
 * Convert a DecodedStreamEvent to an AppliedEvent for the invalidation router.
 */
export function toAppliedEvent(
  e: DecodedStreamEvent,
  streamDid: StreamDid,
): AppliedEvent {
  const event = e.event as unknown as Record<string, unknown>;
  return {
    type: e.event.$type,
    streamDid,
    user: e.user,
    id: e.event.id,
    roomId: event["room"] as Ulid | undefined,
    details: extractDetails(event),
  };
}
