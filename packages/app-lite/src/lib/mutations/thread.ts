import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";
import { createRoom } from "./room";

/**
 * Create a thread from selected messages.
 * 1. Creates a new "space.roomy.thread" room
 * 2. Links it to the parent room
 * 3. Moves each selected message into the thread
 *
 * All events are batched into a single sendEvents call.
 */
export async function createThread({
  spaceId,
  parentRoomId,
  threadName,
  messageIds,
}: {
  spaceId: string;
  parentRoomId: string;
  threadName: string;
  messageIds: string[];
}): Promise<string> {
  // 1. Create the thread room
  const threadId = await createRoom(spaceId, {
    kind: "space.roomy.thread",
    name: threadName,
  });

  // 2. Build link + move events
  const events: Array<Record<string, unknown>> = [];

  // Link from parent → thread
  events.push({
    id: newUlid(),
    room: parentRoomId,
    $type: "space.roomy.link.createRoomLink.v0",
    linkToRoom: threadId,
    isCreationLink: true,
  });

  // Move each selected message into the thread
  for (const msgId of messageIds) {
    events.push({
      id: newUlid(),
      room: parentRoomId,
      $type: "space.roomy.message.moveMessages.v0",
      messageIds: [msgId],
      toRoomId: threadId,
    });
  }

  await sendEvents(spaceId, events);
  return threadId;
}
