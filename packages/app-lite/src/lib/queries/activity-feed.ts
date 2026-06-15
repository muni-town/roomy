import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

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
    };
  });
}
