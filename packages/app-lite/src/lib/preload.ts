/**
 * Background data preloading.
 *
 * Two tiers, both fire-and-forget from the UI:
 *
 * 1. `preloadSpaceSidebars()` — after auth completes, prefetch the sidebar
 *    (`getSpaceMetadata`) for every joined space. When the user opens a space
 *    the sidebar renders from cache instead of a cold fetch.
 *
 * 2. `preloadRoomMessages(spaceId)` — when a space is open and its sidebar is
 *    loaded, prefetch the first page of `getMessages` for a *prioritized, capped*
 *    subset of the readable rooms in that space. Navigating into one of those
 *    rooms then renders instantly.
 *
 * Priority ordering (so the requests most likely to be UX-critical hit the
 * appserver first):
 *   - `preloadSpaceSidebars` fetches spaces with unreads before quiet ones.
 *   - `preloadRoomMessages` fetches the currently-open room first, then rooms
 *     with unread messages (the ones the user is most likely to click next),
 *     then the rest — and stops at `MAX_ROOM_PREFETCH`. A large space must
 *     never fan a `getMessages` burst out to every readable room for every user
 *     who opens it; rooms past the cap fetch on their own mount when opened.
 *
 * `getMessages` is NOT in the appserver's response cache (see `CACHEABLE_NSIDS`
 * in `appserver/src/cache`), so every prefetched room is a real per-user DB
 * query on the space worker. The cap + priority order keeps that fan-out
 * bounded as concurrent users × rooms grows.
 *
 * Why `ensureQueryData` and not SvelteKit preload hooks: all app data lives in
 * the TanStack cache (`staleTime: Infinity`, WS is the sole freshness
 * authority — see `client.ts`). `data-sveltekit-preload-data="hover"` only
 * covers SvelteKit `load` data, which this app doesn't use for room data.
 * `ensureQueryData` returns immediately on a cache hit and only fetches on a
 * miss, so re-running these on navigation/metadata updates is free for
 * already-prefetched entries — and the WS `#messageDiff`/`#roomMetadataDiff`
 * patchers keep prefetched entries live (they already tolerate absent entries).
 *
 * Concurrency is bounded (4 in flight) so a space with many rooms doesn't
 * fan out into an appserver request spike (see the prefetch-link-summaries
 * note about cold-cache fan-out).
 */

import { cache } from "@roomy-space/sdk";
import { queryClient } from "$lib/client";
import { px } from "$lib/auth.svelte";

const { queryKey } = cache;

const GET_SPACES = "space.roomy.space.getSpaces";
const SPACE_METADATA = "space.roomy.space.getMetadata";
const GET_MESSAGES = "space.roomy.room.getMessages";

const MESSAGES_LIMIT = "50";
const CONCURRENCY = 4;

/**
 * Hard cap on how many rooms get a first-page message prefetch per space entry.
 *
 * `preloadRoomMessages` used to prefetch *every* readable room in a space. For
 * a large room set that made each space-open × concurrent-user fan a
 * `getMessages` burst out to O(rooms) per-user DB queries — a load-amplifier on
 * the space worker (getMessages is not in the server response cache). Rooms past
 * the cap are not prefetched; they fetch their first page lazily on mount.
 */
const MAX_ROOM_PREFETCH = 12;

/** Run `fn` over `items` with at most `CONCURRENCY` in flight. Best-effort. */
async function withConcurrency<T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, items.length) },
    async () => {
      while (i < items.length) {
        const item = items[i++];
        if (item === undefined) break;
        try {
          await fn(item);
        } catch {
          // Best-effort: a failed prefetch must never break the caller.
        }
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Prefetch the sidebar (`getSpaceMetadata`) for every joined space.
 * Call once after auth completes; idempotent via `ensureQueryData`.
 *
 * Spaces with unreads are fetched first: they're the ones the user is most
 * likely to open, so their sidebar completes earliest. `getMetadata` is in the
 * appserver's response cache, so across users these are cheap to serve.
 */
export async function preloadSpaceSidebars(): Promise<void> {
  const spaces = await queryClient.ensureQueryData({
    queryKey: queryKey(GET_SPACES, { includeLeft: "true" }),
    queryFn: () => px().query(GET_SPACES, { includeLeft: "true" }),
  });
  const joined = [...spaces.spaces]
    .filter((s) => s.isMember)
    .sort((a, b) => (b.unreadRoomCount ?? 0) - (a.unreadRoomCount ?? 0));
  await withConcurrency(joined, (space) =>
    queryClient.ensureQueryData({
      queryKey: queryKey(SPACE_METADATA, { spaceId: space.id }),
      queryFn: () => px().query(SPACE_METADATA, { spaceId: space.id }),
    }),
  );
}

/**
 * Prefetch the first page of messages for a prioritized, capped set of rooms
 * in a space. Call when the space is open and its sidebar is available;
 * idempotent via `ensureQueryData` (cache hits return immediately, so
 * re-running on sidebar updates only fetches newly-appeared rooms).
 *
 * Ranking (highest priority first), then truncated to `MAX_ROOM_PREFETCH`:
 *   1. `preferredFirstId`, if it's a readable room (the room the user is
 *      currently in — reopening it is the most likely next action);
 *   2. rooms with unread messages (most likely to be clicked next);
 *   3. the remaining rooms, in sidebar order.
 *
 * @param opts.preferredFirstId the id of the user's active room, if any.
 */
export async function preloadRoomMessages(
  spaceId: string,
  opts: { preferredFirstId?: string } = {},
): Promise<void> {
  const meta = await queryClient.ensureQueryData({
    queryKey: queryKey(SPACE_METADATA, { spaceId }),
    queryFn: () => px().query(SPACE_METADATA, { spaceId }),
  });

  const rooms: { id: string; unread: boolean }[] = [];
  const seen = new Set<string>();
  const add = (id: string, unread: boolean) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    rooms.push({ id, unread });
  };
  const collect = (channels: readonly {
    id: string;
    canRead: boolean;
    unreadCount?: number;
    activeThreads?: readonly {
      id: string;
      canRead: boolean;
      unreadCount?: number;
    }[];
  }[]) => {
    for (const ch of channels) {
      if (ch.canRead) add(ch.id, (ch.unreadCount ?? 0) > 0);
      for (const t of ch.activeThreads ?? []) {
        if (t.canRead) add(t.id, (t.unreadCount ?? 0) > 0);
      }
    }
  };
  collect(meta.sidebar.categories.flatMap((c) => c.channels));
  collect(meta.sidebar.orphans);

  const preferred =
    opts.preferredFirstId && seen.has(opts.preferredFirstId)
      ? opts.preferredFirstId
      : undefined;
  const unreadById = new Map(rooms.map((r) => [r.id, r.unread]));
  const score = (id: string) =>
    id === preferred ? 2 : unreadById.get(id) ? 1 : 0;
  // Sort is stable, so rooms with equal score keep sidebar order.
  rooms.sort((a, b) => score(b.id) - score(a.id));
  const ranked = rooms.slice(0, MAX_ROOM_PREFETCH);
  if (ranked.length === 0) return;

  await withConcurrency(ranked, ({ id }) =>
    queryClient.ensureQueryData({
      queryKey: queryKey(GET_MESSAGES, { roomId: id }),
      queryFn: async () => {
        const res = await px().query(GET_MESSAGES, {
          roomId: id,
          limit: MESSAGES_LIMIT,
        });
        return res.messages;
      },
    }),
  );
}
