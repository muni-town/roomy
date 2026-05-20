import { createQuery } from "@tanstack/svelte-query";
import { transport, cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { agentQuery } = transport;
const { queryKey } = cache;

export function createSpacesQuery() {
  return createQuery(() => ({
    queryKey: queryKey("space.roomy.space.getSpaces"),
    queryFn: () => agentQuery(px(), "space.roomy.space.getSpaces", {}),
  }));
}
