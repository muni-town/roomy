import { createQuery } from "@tanstack/svelte-query";
import { cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

/** Options for {@link createSpacesQuery}. */
export interface SpacesQueryOptions {
  /** When true, include spaces the user has previously left (`isMember = false`). */
  includeLeft?: boolean;
}

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
    // A pulled view, like the activity feed: a message-driven change to the
    // list is evicted server-side with no frame (see `cacheEvictionOnly` in
    // the appserver's `invalidation/types.ts`), so a mount reissues the read.
    // `staleTime: 0` is the lever — the app-wide default is `Infinity` — and
    // why not `refetchOnMount` is spelled out in `activity-feed.ts`. The last
    // answer keeps rendering while the refetch is in flight.
    //
    // The per-user cases (join, leave, a role or admin change, a read that
    // drained the space, a reorder) still arrive as frames and still
    // invalidate this query, so the list stays current for its own changes
    // without a remount.
    staleTime: 0,
  }));
}
