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
  /** Target message id when this message is a reply (raw `reply` edge). */
  replyTo?: string;
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
 * Hard bound on a single `space.roomy.room.getMessages` request: the appserver
 * validates `limit` with `max: 100` and answers 400 above that. Callers asking
 * for more must page — see `readMessages`, which never exceeds this per call.
 */
export const MAX_PAGE_LIMIT = 100;

/** One page of room history, as returned by a single `getMessages` request. */
export interface MessagePage {
  /** The page's messages, oldest → newest. */
  messages: MessageInfo[];
  /**
   * Cursor continuing the walk strictly older than the last message returned.
   * Absent when the room's history is exhausted.
   */
  cursor?: string;
}

export interface ReadMessagesOptions {
  /** Total messages to collect across pages. Default 20. */
  limit?: number;
  /** Start from messages older than this id (a previous read's cursor). */
  cursor?: string;
}

/**
 * Fetch one page of messages older than `cursor`, never asking for more than
 * `MAX_PAGE_LIMIT` (a larger request is a 400 from the appserver).
 */
export async function readMessagePage(
  xrpc: DirectXrpcClient,
  roomId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<MessagePage> {
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? MAX_PAGE_LIMIT)),
    MAX_PAGE_LIMIT,
  );
  const result = await xrpc.query("space.roomy.room.getMessages", {
    roomId,
    limit: String(limit),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
  });

  return {
    messages: result.messages.map((m) => ({
      id: m.id,
      authorDid: m.authorDid,
      authorName: m.authorName,
      content: decodeMessageText(m.content, m.mimeType),
      timestamp: m.timestamp,
      mimeType: m.mimeType,
      replyTo: m.replyTo,
    })),
    cursor: result.cursor,
  };
}

/**
 * Read up to `limit` messages from a room, walking the server's cursor across
 * as many bounded requests as it takes, so `readMessages(..., { limit: 250 })`
 * returns 250 messages instead of a 400.
 *
 * The returned `cursor` continues past the last message collected, which is
 * what makes deep history addressable: pass it back to resume without
 * re-reading the newest messages. It is absent only when the room has no
 * older messages left (the server returns a cursor exactly when it filled the
 * page, so a short page means the history is exhausted).
 */
export async function readMessages(
  xrpc: DirectXrpcClient,
  roomId: string,
  { limit = 20, cursor }: ReadMessagesOptions = {},
): Promise<MessagePage> {
  const target = Math.max(1, Math.floor(limit));
  const pages: MessageInfo[][] = [];
  let collected = 0;
  let next = cursor;

  while (collected < target) {
    const page = await readMessagePage(xrpc, roomId, {
      limit: Math.min(target - collected, MAX_PAGE_LIMIT),
      cursor: next,
    });
    pages.push(page.messages);
    collected += page.messages.length;

    // No cursor (short page) or a cursor that failed to advance = the room has
    // no older messages left; the cursor ends here rather than pointing at
    // messages the caller already has.
    if (!page.cursor || page.cursor === next) {
      next = undefined;
      break;
    }
    next = page.cursor;
  }

  // Every page is ascending and each subsequent page is strictly older, so
  // reversing the page order (without touching order within a page) yields the
  // window oldest → newest — matching what a single-page read returns.
  const messages = pages.reverse().flat();
  return { messages, cursor: next };
}
