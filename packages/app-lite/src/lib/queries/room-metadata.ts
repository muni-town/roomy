import { createQuery } from "@tanstack/svelte-query";
import { transport, cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { agentQuery } = transport;
const { queryKey } = cache;

export function createRoomMetadataQuery(roomId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.room.getMetadata", { roomId: roomId() }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.room.getMetadata", { roomId: roomId() }),
  }));
}
