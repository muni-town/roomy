import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

export function createSpaceMetadataQuery(
  spaceId: () => string,
  opts?: { enabled?: boolean },
) {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getMetadata", { spaceId: spaceId() }),
    queryFn: () =>
      px().query("space.roomy.space.getMetadata", {
        spaceId: spaceId(),
      }),
    enabled: opts?.enabled,
  }));
}
