import { createQuery } from "@tanstack/svelte-query";
import { transport, cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { agentQuery } = transport;
const { queryKey } = cache;

export type SpaceThread = typeof schemas.queries.getSpaceThreads.Thread.infer;
export type RoomThread = typeof schemas.queries.getRoomThreads.RoomThread.infer;

export function createSpaceThreadsQuery(spaceId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getThreads", { spaceId: spaceId() }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.space.getThreads", { spaceId: spaceId() }),
  }));
}

export function createRoomThreadsQuery(roomId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.room.getThreads", { roomId: roomId() }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.room.getThreads", { roomId: roomId() }),
  }));
}
