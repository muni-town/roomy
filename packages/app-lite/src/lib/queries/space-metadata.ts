import { createQuery } from "@tanstack/svelte-query";
import { transport, cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { agentQuery } = transport;
const { queryKey } = cache;

export function createSpaceMetadataQuery(spaceId: () => string) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getMetadata", { spaceId: spaceId() }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.space.getMetadata", {
        spaceId: spaceId(),
      }),
  }));
}
