import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export function createRoomMetadataQuery(
  roomId: () => string,
  opts?: { enabled?: boolean },
) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.room.getMetadata", { roomId: roomId() }),
    queryFn: () =>
      px().query("space.roomy.room.getMetadata", { roomId: roomId() }),
    enabled: opts?.enabled,
  }));
}
