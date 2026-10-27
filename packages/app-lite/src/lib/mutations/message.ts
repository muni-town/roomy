import { decodeTime, newUlid, serializeBlocks, toBytes } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
import {
  MAX_TILES_PER_MESSAGE,
  tileAddressesInBlocks,
} from "@roomy/design/components/content/thread/message/tiles/message-tiles.js";
import { auth } from "$lib/auth.svelte";
import type { Message } from "$lib/queries/messages";
import { trackTilePost, type TilePostSource } from "$lib/telemetry/tile-events";
import {
  confirmPendingSend,
  failPendingSend,
  startPendingSend,
} from "./pending-sends.svelte";
import { sendEvents } from "./send-events";
import { isRematerialising } from "$lib/write-refusal.svelte";
import {
  buildForwardEvents,
  MAX_EVENTS_PER_SEND,
  type ForwardTarget,
} from "./forward";

/** The attachment `$type` that carries a Web Tile. */
const TILE_ATTACHMENT = "space.roomy.attachment.tile.v0";

/**
 * Count the tiles a message carries, from both places they can arrive: the
 * addresses its body spells out, and the tile attachments beside it.
 *
 * `inline` is the body-only case; any tile attachment makes the message an
 * `attachment` one, even when the body spells addresses out too. Capped at
 * {@link MAX_TILES_PER_MESSAGE}, which is what a reader is shown and what the
 * event's range is defined as.
 */
function tilePostFor(
  blocks: Block[],
  attachments: Record<string, unknown>[],
): { count: number; source: TilePostSource } | undefined {
  const inline = tileAddressesInBlocks(blocks).length;
  const attached = attachments.filter((a) => a.$type === TILE_ATTACHMENT).length;
  const count = Math.min(inline + attached, MAX_TILES_PER_MESSAGE);
  if (count === 0) return undefined;
  return { count, source: attached > 0 ? "attachment" : "inline" };
}

/** Base64 of a message body, matching the appserver's `decodeContent` (which
 *  base64-encodes every non-`text/*` body for the wire). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Send a message.
 *
 * Every client-authored message body is blocks+facets
 * (`application/vnd.roomy.richtext+json`) — there is no markdown body path.
 * Legacy `text/markdown` bodies still exist on the wire and are rendered and
 * edited as markdown (see {@link editMessage}), but nothing authors new ones.
 *
 * The composer's Send button and its Enter key both route through this
 * function (via `ChatInput.submit()`), so a message encodes identically
 * however it was submitted.
 *
 * The message is inserted into the room's `getMessages` cache before the
 * request goes out (see {@link startPendingSend}), so it renders immediately
 * as pending instead of waiting for the server round-trip. `onQueued` fires
 * at exactly that moment — the message has left the composer and is now the
 * room's to deliver, so the caller can hand the composer back to the user
 * rather than blocking it on the round-trip. A failure after that point
 * leaves the row marked failed — the caller offers a retry
 * (see `ChatInputArea.handleSend`).
 */
export async function sendMessage(
  spaceId: string,
  roomId: string,
  opts: {
    /** Blocks+facets body. */
    blocks: Block[];
    /** Attachments to attach (uploaded media). A reply is added on top. */
    attachments?: Record<string, unknown>[];
    /** Reply-to message id, encoded as a reply attachment. */
    replyTo?: string;
    /**
     * Called once the optimistic placeholder is in the room's cache, before
     * the event is sent. The message is queued at this point; what happens to
     * it from here is delivery, not composition.
     */
    onQueued?: () => void;
  },
): Promise<string> {
  const attachments = [
    ...(opts.attachments ?? []),
    ...(opts.replyTo
      ? [
          {
            $type: "space.roomy.attachment.reply.v0",
            target: opts.replyTo,
          },
        ]
      : []),
  ];

  const serialized = serializeBlocks(opts.blocks);
  const draft: Record<string, unknown> = {
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: { mimeType: serialized.mimeType, data: toBytes(serialized.data) },
    extensions:
      attachments.length > 0
        ? {
            "space.roomy.extension.attachments.v0": {
              $type: "space.roomy.extension.attachments.v0",
              attachments,
            },
          }
        : {},
  };

  const content = toBase64(serialized.data);
  const { id, event } = startPendingSend({
    spaceId,
    roomId,
    draft,
    message: (id) => {
      const profile = auth.profile;
      // Mirrors the appserver's projection: one attachment entry per
      // composer attachment, carrying the `$type` the message will carry. An
      // embed-backed attachment's URL gains a `?message=<id>` query (see
      // `selectMessages` / the createMessage materialiser), so the optimistic
      // row renders the same image the server will return at the same URL.
      // Replies and links produce no embed row, so they are not media here
      // either.
      const optimistic = attachments.flatMap((a): unknown[] => {
        const $type = typeof a.$type === "string" ? a.$type : undefined;
        if ($type === "space.roomy.attachment.reply.v0") {
          return [{ $type, messageId: a.target }];
        }
        const { uri, mimeType: type } = a;
        if (typeof $type !== "string" || typeof uri !== "string" || typeof type !== "string") {
          return [];
        }
        return [
          {
            $type,
            url: `${uri}?message=${id}`,
            type,
            ...(typeof a.alt === "string" ? { alt: a.alt } : {}),
            ...(typeof a.size === "number" ? { size: a.size } : {}),
            ...(typeof a.name === "string" ? { name: a.name } : {}),
          },
        ];
      }) as Message["attachments"];
      return {
        id,
        content,
        mimeType: serialized.mimeType,
        authorDid: auth.userDid ?? "",
        authorName: profile?.displayName ?? profile?.handle ?? "",
        ...(profile?.handle ? { authorHandle: profile.handle } : {}),
        ...(profile?.avatar ? { authorAvatar: profile.avatar } : {}),
        timestamp: new Date(decodeTime(id)).toISOString(),
        attachments: optimistic,
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        reactions: [],
        media: [],
        linkEmbeds: [],
      } satisfies Message;
    },
  });

  // The placeholder is in the cache: the message is queued. Everything past
  // this is delivery, so the caller's composer is free again.
  opts.onQueued?.();

  try {
    await sendEvents(spaceId, [event]);
    confirmPendingSend(id);
  } catch (e) {
    // Held off, not rejected: a write to a space mid rebuild never reached the
    // log, so the placeholder is retained as waiting — Retry resends this same
    // event under the same ULID.
    failPendingSend(id, isRematerialising(e) ? "queued" : "failed");
    throw e;
  }

  // Counted only once the message is delivered: a failed send is not a tile
  // anyone can have seen.
  const tilePost = tilePostFor(opts.blocks, attachments);
  if (tilePost) trackTilePost(tilePost.count, tilePost.source);
  return id;
}

export async function editMessage(
  spaceId: string,
  roomId: string,
  messageId: string,
  body: string,
  opts: {
    mimeType?: string;
    mentions?: string[];
    /** Blocks+facets body (new format). When set, `body` is ignored and the
     *  wire body is `serializeBlocks(blocks)`; the mentions sidecar is
     *  dropped (mentions fold into `#didMention` facets). */
    blocks?: Block[];
    /** Attachments to set on the message (via the attachments extension). A
     *  link attachment carrying `showPreview: false` removes/dismisses that
     *  link embed on the author's own message. */
    attachments?: Record<string, unknown>[];
  } = {},
): Promise<string> {
  const id = newUlid();
  const extensions: Record<string, unknown> = {};
  if (opts.blocks) {
    // New format: mentions live in `#didMention` facets — no sidecar.
  } else if (opts.mentions && opts.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: opts.mentions,
    };
  }
  if (opts.attachments && opts.attachments.length > 0) {
    extensions["space.roomy.extension.attachments.v0"] = {
      $type: "space.roomy.extension.attachments.v0",
      attachments: opts.attachments,
    };
  }

  const wireBody = opts.blocks
    ? {
        mimeType: "application/vnd.roomy.richtext+json",
        data: toBytes(new TextEncoder().encode(JSON.stringify({
          $type: "space.roomy.richtext.document",
          blocks: opts.blocks,
        }))),
      }
    : {
        mimeType: opts.mimeType ?? "text/markdown",
        data: toBytes(new TextEncoder().encode(body)),
      };

  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.editMessage.v0",
    messageId,
    body: wireBody,
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };

  await sendEvents(spaceId, [event]);
  return id;
}

export async function deleteMessage(
  spaceId: string,
  roomId: string,
  messageId: string,
): Promise<string> {
  const id = newUlid();
  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.deleteMessage.v0",
    messageId,
  };

  await sendEvents(spaceId, [event]);
  return id;
}

/**
 * Delete one or more messages from a room.
 *
 * `space.roomy.message.deleteMessage.v0` carries a single `messageId`, so this
 * emits one event per message. `sendEvents` caps a batch at
 * `MAX_EVENTS_PER_SEND`, so a larger selection is split across calls in input
 * order. The events are independent, and a call that the appserver rejects
 * propagates to the caller rather than being retried for the remainder.
 */
export async function deleteMessages(
  spaceId: string,
  roomId: string,
  messageIds: string[],
): Promise<void> {
  const events = messageIds.map((messageId) => ({
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.deleteMessage.v0",
    messageId,
  }));

  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_SEND) {
    await sendEvents(spaceId, events.slice(i, i + MAX_EVENTS_PER_SEND));
  }
}

/**
 * Remove (dismiss) a link embed from the author's own message. Sends an
 * `editMessage` event carrying a link attachment with `showPreview: false` so
 * the embed preview stops rendering for that URL, without altering the message
 * body or other attachments.
 *
 * @param opts - Carries the message's current body so it can be re-sent
 *   unchanged: `mimeType` + `body` for legacy markdown bodies, or `blocks`
 *   for richtext bodies.
 */
export async function removeLinkEmbed(
  spaceId: string,
  roomId: string,
  messageId: string,
  url: string,
  opts: {
    body?: string;
    mimeType?: string;
    blocks?: Block[];
  } = {},
): Promise<string> {
  return editMessage(spaceId, roomId, messageId, opts.body ?? "", {
    mimeType: opts.mimeType,
    blocks: opts.blocks,
    attachments: [
      {
        $type: "space.roomy.attachment.link.v0",
        uri: url,
        showPreview: false,
      },
    ],
  });
}

/**
 * Move one or more messages to another room. The originals relocate — no copy
 * is created, unlike {@link forwardMessage}.
 *
 * `space.roomy.message.moveMessages.v0` caps `messageIds` at one entry until
 * LibSQL TVFs land, so this emits one event per message. `sendEvents` caps a
 * batch at `MAX_EVENTS_PER_SEND`, so a larger selection is split across calls
 * in input order; a rejected call propagates rather than being retried.
 */
export async function moveMessages(
  spaceId: string,
  fromRoomId: string,
  messageIds: string[],
  toRoomId: string,
): Promise<void> {
  const events = messageIds.map((messageId) => ({
    id: newUlid(),
    room: fromRoomId,
    $type: "space.roomy.message.moveMessages.v0",
    messageIds: [messageId],
    toRoomId,
  }));

  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_SEND) {
    await sendEvents(spaceId, events.slice(i, i + MAX_EVENTS_PER_SEND));
  }
}

/**
 * Forward messages into another room as embeds, in the order they appear in
 * the source room's timeline.
 *
 * Each destination room gets ONE `sendEvents` call carrying every forward, in
 * source order — see `forward.ts` for why that order is what the destination
 * pages by. A selection larger than the endpoint's batch cap is split across
 * calls, each keeping the source order.
 */
export async function forwardMessages(
  spaceId: string,
  fromRoomId: string,
  toRoomId: string,
  targets: readonly ForwardTarget[],
  opts: {
    /** Blocks+facets commentary body. Omit/empty for a bare forward. */
    blocks: Block[];
  },
): Promise<void> {
  if (targets.length === 0) return;
  const events = buildForwardEvents(fromRoomId, toRoomId, targets, opts.blocks);
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_SEND) {
    await sendEvents(spaceId, events.slice(i, i + MAX_EVENTS_PER_SEND));
  }
}
