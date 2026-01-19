import { newUlid, type StreamDid, type Ulid } from "@roomy/sdk";
import { backend } from "$lib/workers/index.svelte";

export async function addReaction(
  spaceId: StreamDid,
  roomId: Ulid,
  messageId: Ulid,
  reaction: string,
) {
  await backend.sendEvent(spaceId, {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.reaction.addReaction.v0",
    reactionTo: messageId,
    reaction,
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
    $type: "space.roomy.reaction.removeReaction.v0",
    reactionId: reactionId,
  });
}
