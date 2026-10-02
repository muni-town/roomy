import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { createSubscriber } from "svelte/reactivity";
import { px } from "$lib/auth.svelte";
import { queryClient } from "$lib/client";
import {
  collectRoomIds,
  isNonMessageReplyTarget,
  isRoomIndexKey,
} from "$lib/queries/room-ids";

const { queryKey } = cache;

export type Message = typeof schemas.queries.getMessage.Response.infer;
type MessageList = typeof schemas.queries.getMessages.Message.infer[];

/**
 * The room ids the client currently holds, as a reactive read.
 *
 * Reading this inside the query options subscribes the observer to the query
 * cache, so a reply whose target becomes classifiable (the room listing it
 * belongs to finishes loading) re-evaluates `enabled` and drops the request
 * without waiting for anything else. Only listing arrivals are forwarded: a
 * message diff fires far more often and cannot change which ids are rooms.
 * The subscription exists only while an effect reads it — see
 * `createSubscriber` — so it costs nothing on a page with no reply previews.
 */
const subscribeToRoomChanges = createSubscriber((update) =>
  queryClient.getQueryCache().subscribe((event) => {
    const queryKey = "query" in event ? event.query.queryKey : undefined;
    if (queryKey && isRoomIndexKey(queryKey)) update();
  }),
);

function roomIds(): ReadonlySet<string> {
  subscribeToRoomChanges();
  return collectRoomIds(queryClient.getQueryCache().getAll());
}

/**
 * Single-message query. Hydrates from the room messages cache if the
 * message is already present, so reply previews don't trigger an extra
 * HTTP fetch when the target is on screen.
 *
 * Three guards keep a *deterministically* failing lookup from being issued:
 * one for reply targets the client can already identify as a room (below),
 * `retry: false` for the rest — a deleted message 404s and a non-message
 * target 400s, and neither becomes true by asking again — and
 * `retryOnMount: false`, without which TanStack's `shouldLoadOnMount`
 * re-issues the fetch for an errored, data-less query on every remount. A bad
 * reply target sits in the message list, so the virtualizer recycles its row
 * on scroll and each recycle would otherwise be another request. With
 * `retryOnMount: false` the lookup is asked at most once per session instead
 * of once per mount.
 */
export function createMessageQuery(
  messageId: () => string,
  roomId: () => string | undefined,
  options?: { enabled?: boolean },
) {
  return createQuery<Message>(() => {
    const target = messageId();
    const room = roomId();
    // `getMessage` resolves its argument as a message and answers `400
    // InvalidRequest "Entity <id> is not a message (no room)"` for any entity
    // without a room — and a message is the ONLY entity type that has one. A
    // reply attachment's `target` can name any entity, so a reply whose target
    // is a room asks a question whose answer can never change: a permanent 400
    // on every render of that reply.
    //
    // The rejection rule is "not a message", not "is my own room", so the
    // guard mirrors the rule rather than the narrower case it used to cover.
    // The client already holds the room ids it can see (the sidebar and boards
    // it renders), so the target is classifiable without fetching. Messages
    // carrying such a target are historical — the writer that produced them is
    // fixed at the appserver — so this only ever suppresses requests for data
    // that already exists. Asking burns a round-trip and logs a 400 on every
    // render of that reply, and the answer can never change.
    const targetIsRoom = isNonMessageReplyTarget(target, room, roomIds());
    return {
      queryKey: queryKey("space.roomy.message.getMessage", { messageId: target }),
      enabled: (options?.enabled ?? true) && !targetIsRoom,
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
