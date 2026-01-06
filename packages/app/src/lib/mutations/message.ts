import { newUlid, type StreamDid, type Ulid } from "$lib/schema";
import { backend } from "$lib/workers";

export async function deleteMessage(
  spaceId: StreamDid,
  roomId: Ulid,
  messageId: Ulid,
) {
  await backend.sendEvent(spaceId, {
    id: newUlid(),
    room: roomId,
    variant: {
      $type: "space.roomy.message.deleteMessage.v0",
      messageId: messageId,
    },
  });
}

export async function reorderMessage(
  streamId: StreamDid,
  roomId: Ulid,
  messageId: Ulid,
  moveAfter: Ulid,
) {
  await backend.sendEvent(streamId, {
    id: newUlid(),
    room: roomId,
    variant: {
      $type: "space.roomy.message.reorderMessage.v0",
      messageId,
      after: moveAfter,
    },
  });
}
