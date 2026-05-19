import { createQuery } from "@tanstack/svelte-query";
import { transport, cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";
import { queryClient } from "$lib/client";

const { agentQuery } = transport;
const { queryKey } = cache;

export type Message = typeof schemas.queries.getMessage.Response.infer;
type MessageList = typeof schemas.queries.getMessages.Message.infer[];

/**
 * Single-message query. Hydrates from the room messages cache if the
 * message is already present, so reply previews don't trigger an extra
 * HTTP fetch when the target is on screen.
 */
export function createMessageQuery(
  messageId: () => string,
  roomId: () => string | undefined,
) {
  return createQuery<Message>(() => ({
    queryKey: queryKey("space.roomy.message.getMessage", {
      messageId: messageId(),
    }),
    queryFn: () =>
      agentQuery(px(), "space.roomy.message.getMessage", {
        messageId: messageId(),
      }),
    initialData: () => {
      const room = roomId();
      if (!room) return undefined;
      const list = queryClient.getQueryData<MessageList>(
        queryKey("space.roomy.room.getMessages", { roomId: room }),
      );
      const hit = list?.find((m) => m.id === messageId());
      return hit as Message | undefined;
    },
  }));
}
