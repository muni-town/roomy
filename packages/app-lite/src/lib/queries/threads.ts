import { createInfiniteQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type SpaceRoom = typeof schemas.queries.getSpaceThreads.Room.infer;
export type RoomThread = typeof schemas.queries.getRoomThreads.RoomThread.infer;

const DEFAULT_LIMIT = 20;

/**
 * placeholderData that keeps the previous page list rendered while a new
 * search term fetches (same space/room), but NOT when the space/room itself
 * changes.
 *
 * The plain `keepPreviousData` keeps the previous query's data as a
 * placeholder for ANY new query key — so switching spaces would keep showing
 * the previous space's threads while the new space's first page loads. By
 * comparing the previous query's key param against the current one, we only
 * carry the old list forward for in-place refetches (search typing), and show
 * a fresh loading state on a real space/room switch.
 */
function keepPreviousDataForSameParam(
  paramKey: "spaceId" | "roomId",
  currentValue: () => string,
) {
  return <TData>(
    previousData: TData | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): TData | undefined => {
    const prevParams = previousQuery?.queryKey[1] as
      | Record<string, unknown>
      | undefined;
    if (prevParams?.[paramKey] === currentValue()) return previousData;
    return undefined;
  };
}

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
    // the loading state. Only for the same space (see helper above).
    placeholderData: keepPreviousDataForSameParam("spaceId", spaceId),
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
    // the loading state. Only for the same room (see helper above).
    placeholderData: keepPreviousDataForSameParam("roomId", roomId),
    gcTime: 0,
  }));
}
