import { createQuery } from "@tanstack/svelte-query";
import { transport, cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

const { agentQuery } = transport;
const { queryKey } = cache;

export type Message = typeof schemas.queries.getMessages.Message.infer;

/**
 * Messages query keyed by `{ roomId }` only — matches the key the
 * SyncRouter patches when applying `#messageDiff` frames. Pagination
 * params (limit/cursor) are passed to `queryFn` but excluded from the
 * cache key.
 */
export function createMessagesQuery(roomId: () => string, limit = 50) {
  return createQuery<Message[]>(() => ({
    queryKey: queryKey("space.roomy.room.getMessages", { roomId: roomId() }),
    queryFn: async () => {
      const res = await agentQuery(px(), "space.roomy.room.getMessages", {
        roomId: roomId(),
        limit: String(limit),
      });
      return res.messages;
    },
  }));
}
