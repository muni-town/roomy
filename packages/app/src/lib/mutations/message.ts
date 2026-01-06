import { newUlid, type StreamDid, type Ulid } from "$lib/schema";
import { backend } from "$lib/workers";

export async function deleteMessage(
  spaceId: StreamDid,
  roomId: Ulid,
  messageId: Ulid,
) {
  await backend.sendEvent(spaceId, {
    id: newUlid(),
    variant: {
      $type: "space.roomy.message.deleteMessage.v0",
      room: roomId,
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
    variant: {
      $type: "space.roomy.message.reorderMessage.v0",
      room: roomId,
      messageId,
      after: moveAfter,
    },
  });
}
