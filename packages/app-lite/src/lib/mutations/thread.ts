import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";
import { createRoom } from "./room";
import { buildForwardEvents, MAX_EVENTS_PER_SEND } from "./forward";
import type { Message } from "$lib/queries/messages";

/**
 * Create a thread from selected messages.
 * 1. Creates a new "space.roomy.thread" room
 * 2. Links it to the parent room
 * 3. Forwards each selected message into the thread (originals stay in place)
 *
 * Forwards use the modern representation: a `createMessage` event carrying a
 * `space.roomy.attachment.forward.v0` attachment (a real message with an
 * empty body — a forward without commentary), mirroring `forwardMessages`.
 * They are ordered by the parent room's timeline and stamped with increasing
 * canonical times, so the thread reads in parent order — see `forward.ts`.
 * The events are sent in batches of the endpoint's cap.
 */
export async function createThread({
  spaceId,
  parentRoomId,
  threadName,
  messages,
}: {
  spaceId: string;
  parentRoomId: string;
  threadName: string;
  messages: readonly Message[];
}): Promise<string> {
  // 1. Create the thread room
  const threadId = await createRoom(spaceId, {
    kind: "space.roomy.thread",
    name: threadName,
  });

  // 2. Link from parent → thread, then the ordered forwards.
  const events: Array<Record<string, unknown>> = [
    {
      id: newUlid(),
      room: parentRoomId,
      $type: "space.roomy.link.createRoomLink.v0",
      linkToRoom: threadId,
      isCreationLink: true,
    },
    ...buildForwardEvents(parentRoomId, threadId, messages, [], Date.now()),
  ];

  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_SEND) {
    await sendEvents(spaceId, events.slice(i, i + MAX_EVENTS_PER_SEND));
  }
  return threadId;
}
