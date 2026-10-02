import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";
import { queryClient } from "$lib/client";

const { queryKey } = cache;
const GET_MESSAGES_NSID = "space.roomy.room.getMessages" as const;

export type Message = typeof schemas.queries.getMessages.Message.infer;

/**
 * The `getMessages` cache key for a room — keyed by `{ roomId }` only, so it
 * matches the key the SyncRouter patches when applying `#messageDiff` frames.
 * Pagination params (limit/cursor) are passed to `queryFn` but excluded from
 * the cache key.
 *
 * Single source of truth for that key: the query, the optimistic send path,
 * and the cache reads all build it here rather than each re-deriving the shape.
 */
export function messagesKey(roomId: string): readonly unknown[] {
  return queryKey(GET_MESSAGES_NSID, { roomId });
}

/**
 * The room a `getMessages` key addresses.
 *
 * A read is addressed by its key, never by the live `roomId` prop: a room
 * switch while the read is in flight would otherwise point its cache merge at
 * the room the reader landed in, writing one room's messages into another's
 * cache. Failing loudly on a key without a room keeps a malformed key from
 * silently addressing the wrong one.
 */
function messagesKeyRoom(key: readonly unknown[]): string {
  const params = key[1] as { roomId?: unknown } | undefined;
  const roomId = params?.roomId;
  if (typeof roomId !== "string" || roomId === "") {
    throw new Error(`getMessages key names no room: ${JSON.stringify(key)}`);
  }
  return roomId;
}

export function createMessagesQuery(roomId: () => string, limit = 50) {
  return createQuery<Message[]>(() => ({
    queryKey: messagesKey(roomId()),
    // A room the appserver holds no row for (a stale link target) 404s
    // deterministically; TanStack's default `retry: 3` re-issues it, turning
    // one failing `getMessages` into three lines in the appserver log. Same
    // guard as the sibling room/space metadata queries. Transport-level retries
    // (rate limits) live in DirectXrpcClient.
    retry: false,
    queryFn: async ({ queryKey: key }) => {
      const room = messagesKeyRoom(key);
      const res = await px().query(GET_MESSAGES_NSID, {
        roomId: room,
        limit: String(limit),
      });
      const fetched = res.messages;

      // The `getMessages` read path is slow (production p50 73 ms, spikes to
      // seconds when the per-space worker is backed up). So a refetch started
      // *before* a message materialized can resolve *after* the WS `#messageDiff`
      // frame patched that message into the cache. TanStack's `setQueryData`
      // (triggered by the refetch) would then REPLACE the cache with the stale
      // snapshot and the just-delivered message vanishes until a hard refresh.
      //
      // Guard by re-merging any WS-delivered message the snapshot doesn't yet
      // include. Read the cache AFTER the await so a patch landing mid-fetch is
      // seen here; a patch landing after this synchronous read is applied on top
      // of the returned value and wins anyway.
      const cached = queryClient.getQueryData<Message[]>(
        messagesKey(room) as unknown[],
      );
      if (cached && cached.length > 0) {
        const fetchedIds = new Set(fetched.map((m) => m.id));
        const extra = cached.filter((m) => !fetchedIds.has(m.id));
        if (extra.length > 0) {
          // Same key the appserver pages and `applyMessageDiff` orders by:
          // `sort_idx`, id as fallback and tie-break. Never `timestamp` — that
          // is the sender's own claim about the time, which is exactly what
          // the server-side ordering key exists to stop mattering.
          return [...fetched, ...extra].sort((a, b) => {
            const byKey = (a.sort_idx ?? a.id).localeCompare(b.sort_idx ?? b.id);
            return byKey !== 0 ? byKey : a.id.localeCompare(b.id);
          });
        }
      }
      return fetched;
    },
  }));
}
