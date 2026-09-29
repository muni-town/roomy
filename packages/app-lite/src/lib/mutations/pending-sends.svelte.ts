/**
 * Delivery state for messages this client has sent but the appserver has not
 * acknowledged yet.
 *
 * A send is optimistic: `sendMessage` builds the event with a client-generated
 * ULID, writes a message-shaped placeholder under the room's `getMessages`
 * cache key, and only then calls `sendEvents`. Because the appserver keys the
 * `#messageDiff` `add` op by that same ULID, the server row *replaces* the
 * placeholder when it arrives — reconciliation is by construction, not a merge
 * step (see `applyMessageDiff`: `map.set(op.key, op.message)`).

 * Delivery state lives here rather than on the cached `Message` so the cache
 * keeps holding server-shaped rows: the diff `add` swaps the entry wholesale
 * (dropping any flag we had attached to it) and an `update` op spreads over it
 * (which would strand a stale flag). Renderers read this registry by id.
 *
 * Queuing is the handoff point from composing to delivery: `sendMessage` fires
 * its `onQueued` callback the moment the placeholder lands, and the composer
 * clears its draft there rather than on the round-trip (see
 * `ChatInputArea.handleSend`). A queued message is therefore already the
 * room's, and the user is free to compose the next one.
 *
 * On failure the placeholder stays in the timeline marked `failed` and the
 * event is retained, so a retry resends the identical payload — same ULID,
 * hence the same reconciliation. Nothing here survives a reload: this is
 * in-place optimistic UI, not an outbox.
 */

import { SvelteMap } from "svelte/reactivity";
import { newUlid } from "@roomy-space/sdk";
import { messagesKey, type Message } from "$lib/queries/messages";
import { queryClient } from "$lib/client";
import { recoverFromWriteRefusal } from "$lib/write-refusal.svelte";
import { sendEvents } from "./send-events";

export type DeliveryState = "pending" | "failed";

interface PendingSend {
  spaceId: string;
  roomId: string;
  /** The fully-formed createMessage event (ULID included), resent verbatim on
   *  retry so the server's `add` reconciles the existing placeholder. */
  event: Record<string, unknown>;
  /** The placeholder written to the room's cache, keyed by `event.id`. */
  message: Message;
}

const sends = new SvelteMap<string, PendingSend>();
const states = new SvelteMap<string, DeliveryState>();

/** Delivery state for a message id, or `undefined` once the appserver has
 *  acknowledged it (or for every message this client didn't author). */
export function getDeliveryState(id: string): DeliveryState | undefined {
  return states.get(id);
}

/**
 * Register a send, write its optimistic placeholder, and return its ULID.
 *
 * When `draft` matches a *failed* send's payload in the same room, that send's
 * ULID is reused and its placeholder kept — pressing Send again after a
 * failure must retry the message, not duplicate it.
 *
 * `draft` is the createMessage event without `id`; `message` builds the
 * placeholder for whichever ULID is chosen here (its timestamp and any media
 * URLs embed it).
 */
export function startPendingSend(opts: {
  spaceId: string;
  roomId: string;
  draft: Record<string, unknown>;
  message: (id: string) => Message;
}): { id: string; event: Record<string, unknown> } {
  const id = reuseFailedSend(opts.roomId, opts.draft) ?? String(newUlid());
  const entry: PendingSend = {
    spaceId: opts.spaceId,
    roomId: opts.roomId,
    event: { id, ...opts.draft },
    message: opts.message(id),
  };
  sends.set(id, entry);
  states.set(id, "pending");
  writePlaceholder(entry);
  return { id, event: entry.event };
}

/** The appserver accepted the send: drop the delivery marker. The placeholder
 *  stays in the cache until the `#messageDiff` `add` swaps in the server row —
 *  until then the optimistic row is a faithful stand-in. */
export function confirmPendingSend(id: string): void {
  sends.delete(id);
  states.delete(id);
}

/** The send failed: keep the placeholder (and its event) so it can be retried. */
export function failPendingSend(id: string): void {
  if (!sends.has(id)) return;
  states.set(id, "failed");
}

/** Resend a pending or failed message under its original ULID. */
export async function retryPendingSend(id: string): Promise<void> {
  const entry = sends.get(id);
  if (!entry) return;
  states.set(id, "pending");
  try {
    await sendEvents(entry.spaceId, [entry.event]);
    confirmPendingSend(id);
  } catch (e) {
    failPendingSend(id);
    // A resend is refused for the same reason the original was: record it so
    // the room's composer and this row's retry both stand down.
    recoverFromWriteRefusal(e, entry.roomId, queryClient);
    throw e;
  }
}

/** Drop a failed message. It was never accepted, so its placeholder goes too. */
export function discardPendingSend(id: string): void {
  const entry = sends.get(id);
  sends.delete(id);
  states.delete(id);
  if (entry) {
    queryClient.setQueryData<Message[]>(
      messagesKey(entry.roomId) as unknown[],
      (prev) => prev?.filter((m) => m.id !== id),
    );
  }
}

/**
 * The ULID of a failed send in this room carrying the same message, if any.
 *
 * Identity is the serialized body plus the reply target — not the full event.
 * A failed send keeps its attachments in the composer, and re-uploading them
 * yields fresh blob URIs, so an exact event match would miss precisely the
 * case this guards: the user pressing Send again on a failed media message
 * must retry it, not leave a second bubble beside the one already marked
 * "Not sent".
 */
function reuseFailedSend(
  roomId: string,
  draft: Record<string, unknown>,
): string | undefined {
  const key = sendIdentity(draft);
  for (const [id, entry] of sends) {
    if (entry.roomId !== roomId) continue;
    if (states.get(id) !== "failed") continue;
    if (sendIdentity(entry.event) !== key) continue;
    return id;
  }
  return undefined;
}

function sendIdentity(event: Record<string, unknown>): string {
  const attachments =
    (
      event.extensions as
        | Record<string, { attachments?: Array<{ $type?: string; target?: string }> }>
        | undefined
    )?.["space.roomy.extension.attachments.v0"]?.attachments ?? [];
  return JSON.stringify({
    body: event.body,
    replyTo: attachments.find((a) =>
      a.$type?.endsWith("attachment.reply.v0"),
    )?.target,
  });
}

/**
 * Upsert the placeholder at the end of the room's cached timeline.
 *
 * A missing cache entry means the room's `getMessages` query was never
 * created, and writing one here would leave it holding a single optimistic
 * message with `staleTime: Infinity` — its history would never load. The
 * composer only renders alongside `ChatArea` for the same room, which always
 * creates the entry.
 */
function writePlaceholder(entry: PendingSend): void {
  const key = messagesKey(entry.roomId) as unknown[];
  if (!queryClient.getQueryState(key)) return;
  queryClient.setQueryData<Message[]>(key, (prev) => {
    const rest = (prev ?? []).filter((m) => m.id !== entry.message.id);
    // Oldest-first, matching the appserver and `applyMessageDiff`.
    return [...rest, entry.message].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  });
}
