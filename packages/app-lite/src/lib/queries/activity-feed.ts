import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { auth, px } from "$lib/auth.svelte";

const { queryKey } = cache;

export type ActivityItem = typeof schemas.queries.getActivityFeed.ActivityItem.infer;
export type ActivityMessage = typeof schemas.queries.getActivityFeed.ActivityMessage.infer;

export interface ActivityFeedOptions {
  spaceId?: string;
  limit?: number;
}

/**
 * Query for the activity feed — a paginated, chronologically-ordered feed
 * of recent activity across the user's spaces (or a single space).
 *
 * Pass `{ spaceId }` to filter to a single space.
 * Pass `{ limit }` to control items per page (1–100, default 50).
 */
export function createActivityFeedQuery(opts: () => ActivityFeedOptions = () => ({})) {
  return createQuery(() => {
    const { spaceId, limit } = opts();
    const params: Record<string, string> = {};
    if (spaceId) params.spaceId = spaceId;
    if (limit !== undefined) params.limit = String(limit);

    return {
      queryKey: queryKey("space.roomy.space.getActivityFeed", params),
      queryFn: () =>
        px().query("space.roomy.space.getActivityFeed", params),
      // A pulled view: the server sends no frame for a message-driven change
      // to the feed (see `cacheEvictionOnly` in the appserver's
      // `invalidation/types.ts`), so the read is reissued on mount instead.
      //
      // `staleTime: 0` is what makes that happen — the app-wide default is
      // `Infinity` (WS invalidation is the freshness authority elsewhere), and
      // under it a mount would serve the cached page forever. `staleTime` and
      // not `refetchOnMount`, because a mount refetch goes through TanStack's
      // default `cancelRefetch: true`, which restarts an in-flight fetch; the
      // SDK cache adapter exists to prevent exactly that for this query, which
      // is expensive (p50 measured in seconds in production), and a stale entry
      // reaches the same mount refetch without touching it.
      //
      // The previous answer keeps rendering while the refetch is in flight:
      // `data` survives a pending fetch, so `isPending` stays false and the
      // list below does not fall back to the skeleton.
      staleTime: 0,
      // The page mounts before auth lands (the root layout renders beneath
      // the login overlay while auth is still resolving), and getActivityFeed
      // 401s for an unauthenticated caller. Gate on auth so the request is
      // never issued in the logged-out window, instead of spamming the
      // appserver log with 401s during page load. This also feeds TanStack's
      // retry backoff, which would otherwise multiply each 401.
      enabled: () => auth.authenticated,
      // A 401 for an unauthenticated feed will never succeed on retry, and
      // TanStack's default `retry: 3` turns one page load into four 401s in
      // the appserver log. Transport-level retries (rate limits) live in
      // DirectXrpcClient.
      retry: false,
    };
  });
}
