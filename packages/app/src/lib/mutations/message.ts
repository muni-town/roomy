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
      target: messageId,
    },
  });
}
