import { createInfiniteQuery, keepPreviousData } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type SpaceRoom = typeof schemas.queries.getSpaceThreads.Room.infer;
export type RoomThread = typeof schemas.queries.getRoomThreads.RoomThread.infer;

const DEFAULT_LIMIT = 20;

export function createSpaceThreadsQuery(
  spaceId: () => string,
  search: () => string | undefined = () => undefined,
) {
  return createInfiniteQuery(() => ({
    queryKey: queryKey("space.roomy.space.getThreads", {
      spaceId: spaceId(),
      ...(search() ? { search: search() } : {}),
    }),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      px().query("space.roomy.space.getThreads", {
        spaceId: spaceId(),
        limit: String(DEFAULT_LIMIT),
        cursor: pageParam,
        ...(search() ? { search: search() } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
    // Keep the previous page list rendered while a new search term fetches —
    // without this, each keystroke flips isPending and the whole view flashes
    // the loading state.
    placeholderData: keepPreviousData,
    gcTime: 0,
  }));
}

export function createRoomThreadsQuery(
  roomId: () => string,
  search: () => string | undefined = () => undefined,
) {
  return createInfiniteQuery(() => ({
    queryKey: queryKey("space.roomy.room.getThreads", {
      roomId: roomId(),
      ...(search() ? { search: search() } : {}),
    }),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      px().query("space.roomy.room.getThreads", {
        roomId: roomId(),
        limit: String(DEFAULT_LIMIT),
        cursor: pageParam,
        ...(search() ? { search: search() } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
    // Keep the previous page list rendered while a new search term fetches —
    // without this, each keystroke flips isPending and the whole view flashes
    // the loading state.
    placeholderData: keepPreviousData,
    gcTime: 0,
  }));
}
