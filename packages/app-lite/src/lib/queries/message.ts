import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";
import { queryClient } from "$lib/client";

const { queryKey } = cache;

export type Message = typeof schemas.queries.getMessage.Response.infer;
type MessageList = typeof schemas.queries.getMessages.Message.infer[];

/**
 * Single-message query. Hydrates from the room messages cache if the
 * message is already present, so reply previews don't trigger an extra
 * HTTP fetch when the target is on screen.
 *
 * Three guards keep a *deterministically* failing lookup from being issued:
 * one for the corrupt-reply case (below), `retry: false` for the rest — a
 * deleted message 404s and a non-message target 400s, and neither becomes
 * true by asking again — and `retryOnMount: false`, without which TanStack's
 * `shouldLoadOnMount` re-issues the fetch for an errored, data-less query on
 * every remount. A bad reply target sits in the message list, so the
 * virtualizer recycles its row on scroll and each recycle would otherwise be
 * another request. With `retryOnMount: false` the lookup is asked at most
 * once per session instead of once per mount.
 */
export function createMessageQuery(
  messageId: () => string,
  roomId: () => string | undefined,
  options?: { enabled?: boolean },
) {
  return createQuery<Message>(() => {
    const target = messageId();
    const room = roomId();
    // A reply whose target IS the room it lives in is not a message:
    // `getMessage` resolves targets as messages and answers `400 InvalidRequest
    // "Entity <id> is not a message (no room)"`. Messages carrying exactly
    // this in production are historical — the writer that produced them is
    // fixed at the appserver — so this only ever suppresses the request for
    // data that already exists. Asking burns a round-trip and logs a 400 on
    // every render of that reply, and the answer can never change.
    const targetIsOwnRoom = room !== undefined && room !== "" && room === target;
    return {
      queryKey: queryKey("space.roomy.message.getMessage", { messageId: target }),
      enabled: (options?.enabled ?? true) && !targetIsOwnRoom,
      queryFn: () =>
        px().query("space.roomy.message.getMessage", { messageId: target }),
      retry: false,
      retryOnMount: false,
      initialData: () => {
        if (!room) return undefined;
        const list = queryClient.getQueryData<MessageList>(
          queryKey("space.roomy.room.getMessages", { roomId: room }),
        );
        const hit = list?.find((m) => m.id === target);
        return hit as Message | undefined;
      },
    };
  });
}
