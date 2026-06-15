import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/**
 * Query for the user's spaces.
 *
 * Pass `{ includeLeft: true }` to include spaces the user has previously left
 * (they appear with `isMember = false`).
 */
export function createSpacesQuery(opts: SpacesQueryOptions = {}) {
  const params: Record<string, string> = {};
  if (opts.includeLeft) {
    params.includeLeft = "true";
  }

  return createQuery(() => ({
    // queryKey handles the params → array conversion:
    //   empty params → ["space.roomy.space.getSpaces"]
    //   with params  → ["space.roomy.space.getSpaces", { includeLeft: "true" }]
    // TanStack prefix matching means invalidating the base key touches both.
    queryKey: queryKey("space.roomy.space.getSpaces", params),
    queryFn: () => px().query("space.roomy.space.getSpaces", params),
  }));
}
