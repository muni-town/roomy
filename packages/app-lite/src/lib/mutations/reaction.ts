import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export async function addReaction(
  spaceId: string,
  roomId: string,
  messageId: string,
  reaction: string,
): Promise<string> {
  const id = newUlid();
  await sendEvents(spaceId, [
    {
      id,
      room: roomId,
      $type: "space.roomy.reaction.addReaction.v0",
      reactionTo: messageId,
      reaction,
    },
  ]);
  return id;
}

export async function removeReaction(
  spaceId: string,
  roomId: string,
  reactionId: string,
): Promise<string> {
  const id = newUlid();
  await sendEvents(spaceId, [
    {
      id,
      room: roomId,
      $type: "space.roomy.reaction.removeReaction.v0",
      reactionId,
    },
  ]);
  return id;
}
