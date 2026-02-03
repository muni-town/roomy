import { newUlid, type StreamDid, type Ulid } from "@roomy/sdk";
import { peer } from "$lib/workers";

export async function deleteMessage(
  spaceId: StreamDid,
  roomId: Ulid,
  messageId: Ulid,
) {
  await peer.sendEvent(spaceId, {
    $type: "space.roomy.message.deleteMessage.v0",
    id: newUlid(),
    room: roomId,
    messageId: messageId,
  });
}

export async function reorderMessage(
  streamId: StreamDid,
  roomId: Ulid,
  messageId: Ulid,
  moveAfter: Ulid,
) {
  await peer.sendEvent(streamId, {
    $type: "space.roomy.message.reorderMessage.v0",
    id: newUlid(),
    room: roomId,
    messageId,
    after: moveAfter,
  });
}
