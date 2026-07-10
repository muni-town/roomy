import { createInfiniteQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type SpaceThread = typeof schemas.queries.getSpaceThreads.Thread.infer;
export type RoomThread = typeof schemas.queries.getRoomThreads.RoomThread.infer;

const DEFAULT_LIMIT = 20;

export function createSpaceThreadsQuery(spaceId: () => string) {
  return createInfiniteQuery(() => ({
    queryKey: queryKey("space.roomy.space.getThreads", { spaceId: spaceId() }),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      px().query("space.roomy.space.getThreads", {
        spaceId: spaceId(),
        limit: String(DEFAULT_LIMIT),
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
    gcTime: 0,
  }));
}

export function createRoomThreadsQuery(roomId: () => string) {
  return createInfiniteQuery(() => ({
    queryKey: queryKey("space.roomy.room.getThreads", { roomId: roomId() }),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      px().query("space.roomy.room.getThreads", {
        roomId: roomId(),
        limit: String(DEFAULT_LIMIT),
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
    gcTime: 0,
  }));
}
