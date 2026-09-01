import { newUlid, toBytes, transport, utf8ByteLength, deserializeBody, blocksToPlaintext } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

/** Prefix marking a thinking-trace message, so consumers can filter the noise
 *  out of context (and out of inter-agent communication). */
export const THINKING_MARKER = "💭";

export interface MessageInfo {
  id: string;
  authorDid: string;
  authorName: string;
  content: string;
  timestamp: string;
  mimeType?: string;
}

/**
 * Render a message body as readable text. Rich-text bodies arrive on the wire
 * as base64-encoded JSON (mimeType application/vnd.roomy.richtext+json); decode
 * them to plaintext so callers don't have to handle raw base64 blobs.
 */
export function decodeMessageText(content: string, mimeType?: string): string {
  return plaintextOf({ content, mimeType });
}

/** Plaintext of a message body regardless of mime type. */
export function plaintextOf(msg: { content: string; mimeType?: string }): string {
  if (msg.mimeType === "application/vnd.roomy.richtext+json") {
    try {
      const bytes = Buffer.from(msg.content, "base64");
      const blocks = deserializeBody(msg.mimeType, bytes);
      if (Array.isArray(blocks)) return blocksToPlaintext(blocks);
    } catch {
      // fall back to raw content if it isn't valid richtext
    }
  }
  return msg.content;
}

export interface SendOptions {
  /** Rich-text blocks body (new format). When set, `text` is ignored and the
   *  wire body is the blocks+facets document. */
  blocks?: Block[];
  /** ID of a message to reply to. Creates a thread rooted at that message. */
  parent?: string;
}

/**
 * Send a message to a room via sendEvents.
 */
export async function sendMessage(
  xrpc: DirectXrpcClient,
  spaceId: string,
  roomId: string,
  text: string,
  opts: SendOptions = {},
): Promise<{ messageId: string }> {
  const messageId = newUlid();
  const body = opts.blocks
    ? {
        mimeType: "application/vnd.roomy.richtext+json",
        data: toBytes(
          new TextEncoder().encode(
            JSON.stringify({
              $type: "space.roomy.richtext.document",
              blocks: opts.blocks,
            }),
          ),
        ),
      }
    : {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(text)),
      };

  const event = {
    id: messageId,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0" as const,
    body,
    extensions: opts.parent
      ? {
          "space.roomy.extension.attachments.v0": {
            attachments: [
              { $type: "space.roomy.attachment.reply.v0", target: opts.parent },
            ],
          },
        }
      : {},
  };

  await xrpc.procedure("space.roomy.space.sendEvents", {
    spaceId,
    events: [event],
  });

  return { messageId };
}

/**
 * Build a rich-text message body that mentions a user via a `#didMention`
 * facet — the Roomy-native mention (renders as a mention chip, not plain
 * text). The label is folded into the block text as `@label` and the facet
 * covers that byte range, matching how the app UI serializes mentions.
 */
export function buildMentionBlocks(
  text: string,
  did: string,
  label: string,
): Block[] {
  const mention = `@${label}`;
  const full = `${mention} ${text}`.trim();
  return [
    {
      $type: "space.roomy.richtext.blocks#text",
      text: full,
      facets: [
        {
          index: { byteStart: 0, byteEnd: utf8ByteLength(mention) },
          features: [
            { $type: "space.roomy.richtext.facet#didMention", did },
          ],
        },
      ],
    },
  ];
}

/**
 * Build the rich-text blocks for the agent's reply: an optional thinking
 * blockquote followed by the answer as normal text. Always includes the answer
 * so the reply is never an empty document.
 */
export function buildReplyBlocks(answer: string, thinking?: string): Block[] {
  const blocks: Block[] = [];
  if (thinking) {
    blocks.push({
      $type: "space.roomy.richtext.blocks#blockquote",
      text: `${THINKING_MARKER} ${thinking}`,
    });
  }
  blocks.push({
    $type: "space.roomy.richtext.blocks#text",
    text: answer,
  });
  return blocks;
}

/** Build a single blockquote block carrying a chunk of the thinking trace. */
export function buildThinkingBlocks(thinking: string): Block[] {
  return [
    {
      $type: "space.roomy.richtext.blocks#blockquote",
      text: `${THINKING_MARKER} ${thinking}`,
    },
  ];
}

/** Post a reply to a room as the agent's own message. Threads the reply under
 *  `parent` when set so task chatter stays in that thread (not the room root). */
export async function sendReply(
  xrpc: DirectXrpcClient,
  spaceId: string,
  roomId: string,
  text: string,
  blocks?: Block[],
  parent?: string,
): Promise<{ messageId: string }> {
  const messageId = newUlid();
  const body = blocks && blocks.length > 0
    ? {
        mimeType: "application/vnd.roomy.richtext+json",
        data: toBytes(
          new TextEncoder().encode(
            JSON.stringify({
              $type: "space.roomy.richtext.document",
              blocks,
            }),
          ),
        ),
      }
    : {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(text)),
      };

  await xrpc.procedure("space.roomy.space.sendEvents", {
    spaceId,
    events: [
      {
        id: messageId,
        room: roomId,
        $type: "space.roomy.message.createMessage.v0",
        body,
        extensions: parent
          ? {
              "space.roomy.extension.attachments.v0": {
                attachments: [
                  { $type: "space.roomy.attachment.reply.v0", target: parent },
                ],
              },
            }
          : {},
      },
    ],
  });

  return { messageId };
}

/**
 * Read messages from a room.
 */
export async function readMessages(
  xrpc: DirectXrpcClient,
  roomId: string,
  limit: number = 20,
): Promise<MessageInfo[]> {
  const result = await xrpc.query("space.roomy.room.getMessages", {
    roomId,
    ...(limit !== 20 ? { limit: String(limit) } : {}),
  });

  return result.messages.map((m) => ({
    id: m.id,
    authorDid: m.authorDid,
    authorName: m.authorName,
    content: decodeMessageText(m.content, m.mimeType),
    timestamp: m.timestamp,
    mimeType: m.mimeType,
  }));
}
