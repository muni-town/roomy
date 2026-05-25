import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export type RoomKind = "space.roomy.channel" | "space.roomy.thread" | "space.roomy.page";

export async function createRoom(
  spaceId: string,
  opts: { kind: RoomKind; name?: string; description?: string; avatar?: string },
): Promise<string> {
  const id = newUlid();
  await sendEvents(spaceId, [
    {
      id,
      $type: "space.roomy.room.createRoom.v0",
      kind: opts.kind,
      ...(opts.name !== undefined && { name: opts.name }),
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts.avatar !== undefined && { avatar: opts.avatar }),
    },
  ]);
  return id;
}

export async function updateRoom(
  spaceId: string,
  opts: {
    roomId: string;
    kind?: RoomKind | null;
    name?: string;
    description?: string;
    avatar?: string;
  },
): Promise<string> {
  const id = newUlid();
  await sendEvents(spaceId, [
    {
      id,
      $type: "space.roomy.room.updateRoom.v0",
      roomId: opts.roomId,
      ...(opts.kind !== undefined && { kind: opts.kind }),
      ...(opts.name !== undefined && { name: opts.name }),
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts.avatar !== undefined && { avatar: opts.avatar }),
    },
  ]);
  return id;
}

export async function deleteRoom(spaceId: string, roomId: string): Promise<string> {
  const id = newUlid();
  await sendEvents(spaceId, [
    {
      id,
      $type: "space.roomy.room.deleteRoom.v0",
      roomId,
    },
  ]);
  return id;
}

export async function restoreRoom(spaceId: string, roomId: string): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.room.restoreRoom.v0",
      roomId,
    },
  ]);
}

export async function updateSidebar(
  spaceId: string,
  categories: Array<{ id: string; name: string; children: string[] }>,
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.space.updateSidebar.v1",
      categories,
    },
  ]);
}
