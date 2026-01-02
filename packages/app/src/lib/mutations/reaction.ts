import { newUlid, type StreamDid, type Ulid } from "$lib/schema";
import { backend } from "$lib/workers";

export async function addReaction(
  spaceId: StreamDid,
  roomId: Ulid,
  messageId: Ulid,
  reaction: string,
) {
  await backend.sendEvent(spaceId, {
    id: newUlid(),
    room: roomId,
    variant: {
      $type: "space.roomy.reaction.addReaction.v0",
      reactionTo: messageId,
      reaction,
    },
  });
}

export async function removeReaction(
  spaceId: StreamDid,
  roomId: Ulid,
  reactionId: Ulid,
) {
  await backend.sendEvent(spaceId, {
    id: newUlid(),
    room: roomId,
    variant: {
      $type: "space.roomy.reaction.removeReaction.v0",
      reactionId: reactionId,
    },
  });
}
