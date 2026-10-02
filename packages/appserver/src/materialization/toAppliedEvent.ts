/**
 * Convert a decoded stream event into an AppliedEvent for the
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
import { extractMentionDids } from "@roomy-space/sdk";
import { decodeRichTextBody } from "../db/content.ts";
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
      const mentionsExt = extensions?.[
        "space.roomy.extension.mentions.v0"
      ] as { mentions?: unknown } | undefined;
      let mentions: string[] | undefined;
      if (Array.isArray(mentionsExt?.mentions)) {
        // Legacy bodies: mentions come from the sidecar extension.
        mentions = mentionsExt!.mentions.filter(
          (d): d is string => typeof d === "string",
        );
      } else {
        // New-format bodies: mentions come from `#didMention` facets.
        const body = event["body"] as
          | { mimeType?: string; data?: { buf?: Uint8Array } }
          | undefined;
        const buf = body?.data?.buf;
        if (body?.mimeType && buf) {
          const blocks = decodeRichTextBody(body.mimeType, Buffer.from(buf));
          if (blocks) mentions = extractMentionDids(blocks);
        }
      }

      const base = {
        authorDid: authorOverride?.did,
        timestamp:
          timestampOverride?.timestamp != null
            ? new Date(timestampOverride.timestamp).toISOString()
            : undefined,
        replyTo: undefined, // resolved from edges after materialization
        mentions,
      };

      // createMessage's entity id IS the event id, so the invalidation
      // handler can key the #messageDiff by `event.id`. editMessage is
      // different: `event.id` is the edit event's own ULID, while the
      // message being edited is `event.messageId`. We MUST surface
      // messageId here so the handler keys the diff by the original
      // message — otherwise the client can't match it to its cache entry
      // and the diff is silently applied as a brand-new (empty) message.
      if (type === "space.roomy.message.editMessage.v0") {
        return { ...base, messageId: event["messageId"] };
      }
      return base;
    }

    // deleteMessage targets an existing message by id; surface it so the
    // handler emits a `remove` op keyed by the message, not the delete
    // event's own ULID.
    case "space.roomy.message.deleteMessage.v0":
      return { messageId: event["messageId"] };

    // moveMessages targets existing messages and carries the destination
    // room. `event.room` (the envelope) is the SOURCE room, so the
    // invalidation handler can emit a `remove` there and an `add` in
    // `toRoomId` — without both, a move is invisible to connected clients
    // (they hold `staleTime: Infinity` and only refresh from WS frames).
    case "space.roomy.message.moveMessages.v0":
      return {
        messageIds: event["messageIds"],
        toRoomId: event["toRoomId"],
      };

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

    // Federation events: surface the counterpart space(s) and, for the
    // per-channel grant events, the affected channel so invalidation can
    // reach the right spaces' queries.
    case "space.roomy.federation.request.v0":
    case "space.roomy.federation.respond.v0":
    case "space.roomy.federation.remove.v0":
      return { federatingSpaceDid: event["federatingSpaceDid"] };

    case "space.roomy.federation.setRoomPermission.v0":
      return {
        federatingSpaceDid: event["federatingSpaceDid"],
        roomId: event["roomId"],
      };

    case "space.roomy.federation.setReceiverPermission.v0":
      return {
        originSpaceId: event["originSpaceId"],
        roomId: event["roomId"],
      };

    // Voice calls: the fields the presence diff carries. `callId` identifies
    // the generation a frame describes, and `userDid` the participant — absent
    // for callStarted/callEnded, which are about the call rather than a person.
    // `recordLeave` emits `callEnded` in the same batch when the last
    // participant leaves, so the op is the event kind and nothing has to be
    // re-derived from the participant count.
    case "space.roomy.voice.callStarted.v0":
    case "space.roomy.voice.callEnded.v0":
      return { callId: event["callId"], source: event["source"] };

    case "space.roomy.voice.callJoined.v0":
    case "space.roomy.voice.callLeft.v0":
      return {
        callId: event["callId"],
        userDid: event["userDid"],
        source: event["source"],
      };

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
