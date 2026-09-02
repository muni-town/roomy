import { newUlid, toBytes } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export async function sendMessage(
  spaceId: string,
  roomId: string,
  body: string,
  opts: {
    mimeType?: string;
    replyTo?: string;
    mentions?: string[];
    /** Blocks+facets body (new format). When set, `body` is ignored and the
     *  wire body is `serializeBlocks(blocks)`; the mentions sidecar is
     *  dropped (mentions fold into `#didMention` facets). */
    blocks?: Block[];
  } = {},
): Promise<string> {
  const id = newUlid();
  const attachments = opts.replyTo
    ? [
        {
          $type: "space.roomy.attachment.reply.v0",
          target: opts.replyTo,
        },
      ]
    : undefined;

  const extensions: Record<string, unknown> = {};
  if (opts.blocks) {
    // New format: mentions live in `#didMention` facets — no sidecar.
  } else if (opts.mentions && opts.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: opts.mentions,
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
        mimeType: opts.mimeType || "text/markdown",
        data: toBytes(new TextEncoder().encode(body)),
      };

  const event: Record<string, unknown> = {
    id,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: wireBody,
    extensions,
    ...(attachments ? { attachments } : {}),
  };

  await sendEvents(spaceId, [event]);
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

export async function forwardMessage(
  spaceId: string,
  fromRoomId: string,
  messageId: string,
  toRoomId: string,
  body = "",
  opts: {
    /** Blocks+facets commentary body (new format). When set, `body` is
     *  ignored and the wire body is the serialized blocks; the mentions
     *  sidecar is dropped (mentions fold into `#didMention` facets). */
    blocks?: Block[];
    /** Mentions sidecar for legacy markdown commentary bodies. */
    mentions?: string[];
  } = {},
): Promise<string> {
  const id = newUlid();
  const extensions: Record<string, unknown> = {
    "space.roomy.extension.attachments.v0": {
      $type: "space.roomy.extension.attachments.v0",
      attachments: [
        {
          $type: "space.roomy.attachment.forward.v0",
          target: messageId,
          fromRoomId,
        },
      ],
    },
  };
  if (opts.blocks) {
    // New format: mentions live in `#didMention` facets — no sidecar.
  } else if (opts.mentions && opts.mentions.length > 0) {
    extensions["space.roomy.extension.mentions.v0"] = {
      $type: "space.roomy.extension.mentions.v0",
      mentions: opts.mentions,
    };
  }
  const event: Record<string, unknown> = {
    id,
    room: toRoomId,
    $type: "space.roomy.message.createMessage.v0",
    body: opts.blocks
      ? {
          mimeType: "application/vnd.roomy.richtext+json",
          data: toBytes(new TextEncoder().encode(JSON.stringify({
            $type: "space.roomy.richtext.document",
            blocks: opts.blocks,
          }))),
        }
      : {
          mimeType: "text/markdown",
          data: toBytes(new TextEncoder().encode(body)),
        },
    extensions,
  };

  await sendEvents(spaceId, [event]);
  return id;
}
