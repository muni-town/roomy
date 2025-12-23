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
      $type: "space.roomy.room.addReaction.v0",
      target: messageId,
      reaction,
    },
  });
}

export async function removeReaction(
  spaceId: StreamDid,
  roomId: Ulid,
  messageId: Ulid,
  reactionId: Ulid,
) {
  await backend.sendEvent(spaceId, {
    id: newUlid(),
    room: roomId,
    variant: {
      $type: "space.roomy.room.removeReaction.v0",
      target: messageId,
      previous: reactionId,
    },
  });
}
