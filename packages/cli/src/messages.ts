import { newUlid, toBytes, transport, utf8ByteLength, deserializeBody, blocksToPlaintext, MAX_TILE_DATA_BYTES } from "@roomy-space/sdk";
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

/**
 * Whether `id` names a message the caller can read.
 *
 * A message is the only entity that has a room, and
 * `space.roomy.message.getMessage` resolves exactly that: it answers 400 for
 * every other entity kind (a room, a thread, a page) and 404 for an id it has
 * never seen. Both are answers about the id. Any other failure — a timeout, a
 * 403 for a message in a room the caller cannot read, a 5xx — says nothing
 * about the id and is rethrown, so callers can tell "not a message" apart from
 * "could not determine".
 */
export async function isMessageId(
  xrpc: DirectXrpcClient,
  id: string,
): Promise<boolean> {
  try {
    await xrpc.query("space.roomy.message.getMessage", { messageId: id });
    return true;
  } catch (error) {
    // The transport attaches the HTTP `status` to errors built from an error
    // response. 400 = the entity is not a message; 404 = no such entity. Both
    // are answers about the id; anything else is not.
    const status =
      error !== null && typeof error === "object" && "status" in error
        ? error.status
        : undefined;
    if (status === 400 || status === 404) return false;
    throw error;
  }
}

/**
 * A Web Tile a message body attaches.
 *
 * The wire shape is a `space.roomy.attachment.tile.v0` attachment; a `tile:`
 * directive is how one is written in text:
 *
 *     tile: at://did:plc:…/ing.dasl.masl/<rkey> payload: { "mermaid": "…" }
 *
 * `data` is the JSON the tile is handed once it loads, and `payload:` may span
 * lines. The directive is removed from the body — the attachment is what
 * renders, so leaving the address in the text would show it twice. Only a
 * markdown body is scanned: a blocks body is the caller's document, and a
 * caller that wants a tile there attaches it through `SendOptions.tiles`.
 */
export interface TileDirective {
  /** The tile manifest's AT-URI: `at://<did:plc:…>/ing.dasl.masl/<rkey>`. */
  uri: string;
  /** JSON handed to the tile; absent when the directive carried no payload. */
  data?: unknown;
}

/**
 * The directive in a body: `tile:` then the address, then an optional
 * `payload:` whose JSON runs to the end of the line (and beyond, if the text
 * that follows is how it closes).
 */
const TILE_DIRECTIVE = /^[ \t]*tile:[ \t]*(\S+)[ \t]*(?:payload:[ \t]*([\s\S]*))?$/;

/**
 * A tile address, mirroring the write schema's `TileUri` so a malformed
 * directive fails here instead of taking the whole `sendEvents` batch down
 * with a 400 the caller cannot attribute. The appserver stays the authority.
 */
const TILE_ADDRESS = /^at:\/\/did:plc:[a-z2-7]+\/ing\.dasl\.masl\/[A-Za-z0-9._~:-]+$/;

/**
 * Read `tile:` directives out of a body, leaving the text they were written
 * in.
 *
 * A directive that cannot become an attachment (not a tile address, no JSON
 * payload, a payload over the log's byte cap) throws rather than being
 * silently dropped: the caller learns before any event is sent.
 */
export function parseTileDirectives(text: string): {
  text: string;
  tiles: TileDirective[];
} {
  const lines = text.split("\n");
  const kept: string[] = [];
  const tiles: TileDirective[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = TILE_DIRECTIVE.exec(lines[i] ?? "");
    if (!head) {
      kept.push(lines[i] ?? "");
      continue;
    }
    const uri = head[1] ?? "";
    if (!TILE_ADDRESS.test(uri)) {
      throw new Error(
        `tile directive: ${uri} is not a tile address ` +
          `(at://<did:plc:…>/ing.dasl.masl/<rkey>)`,
      );
    }
    // A payload runs past this line when it is a JSON object or array written
    // over several lines; the first line at which it parses is its last.
    let payload = head[2]?.trim() ?? "";
    if (payload === "") {
      tiles.push({ uri });
      continue;
    }
    let data: unknown;
    let end = i;
    for (;;) {
      try {
        data = JSON.parse(payload);
        break;
      } catch {
        end += 1;
        if (end >= lines.length) {
          throw new Error(
            `tile directive for ${uri}: payload is not JSON ` +
              `(${JSON.stringify(payload.slice(0, 80))}…)`,
          );
        }
        payload += `\n${lines[end] ?? ""}`;
      }
    }
    const bytes = utf8ByteLength(JSON.stringify(data) ?? "");
    if (bytes > MAX_TILE_DATA_BYTES) {
      throw new Error(
        `tile directive for ${uri}: payload is ${bytes} bytes, ` +
          `over the ${MAX_TILE_DATA_BYTES}-byte limit`,
      );
    }
    tiles.push({ uri, data });
    i = end;
  }
  return { text: kept.join("\n").trim(), tiles };
}

export interface SendOptions {
  /** Rich-text blocks body (new format). When set, the text body is replaced
   *  by this blocks+facets document. */
  blocks?: Block[];
  /**
   * Message id this message replies to. The reply is attached as a
   * `space.roomy.attachment.reply.v0`; it does NOT create a thread room.
   * Must name a message — `sendMessage` rejects anything else locally.
   */
  parent?: string;
  /** Web Tiles to attach, in addition to any `tile:` directives in the body. */
  tiles?: TileDirective[];
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
  // A reply attachment's target must be a message, and the appserver rejects
  // the whole sendEvents batch otherwise — the caller learns that only from a
  // 400 naming an id it believed was a message. Reject a definite
  // non-message here instead, before any event is built or sent, so no
  // sendEvents call leaves the process.
  //
  // The probe is best-effort: it is skipped entirely when it cannot tell (a
  // timeout, or a message the caller cannot read → 403), because the appserver
  // stays the authority and an inconclusive probe must not block a valid send.
  if (opts.parent) {
    let isMessage = true;
    try {
      isMessage = await isMessageId(xrpc, opts.parent);
    } catch {
      // Inconclusive — let sendEvents decide.
    }
    if (!isMessage) {
      throw new Error(
        `Reply target ${opts.parent} is not a message id — --parent takes a message, not a room or thread`,
      );
    }
  }
  const parsed = opts.blocks
    ? { text, tiles: [] as TileDirective[] }
    : parseTileDirectives(text);
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
        data: toBytes(new TextEncoder().encode(parsed.text)),
      };

  const attachments: Record<string, unknown>[] = [];
  if (opts.parent) {
    attachments.push({
      $type: "space.roomy.attachment.reply.v0",
      target: opts.parent,
    });
  }
  for (const tile of [...(opts.tiles ?? []), ...parsed.tiles]) {
    attachments.push({
      $type: "space.roomy.attachment.tile.v0",
      uri: tile.uri,
      ...(tile.data === undefined ? {} : { data: tile.data }),
    });
  }

  const event = {
    id: messageId,
    room: roomId,
    $type: "space.roomy.message.createMessage.v0" as const,
    body,
    extensions:
      attachments.length > 0
        ? {
            "space.roomy.extension.attachments.v0": { attachments },
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

/** Post a reply to a room as the agent's own message. Attaches the reply to
 *  `parent` when set, so task chatter stays under that message rather than at
 *  the room root. A `parent` that is not a message is rejected before any
 *  event is sent (see {@link sendMessage}). */
export async function sendReply(
  xrpc: DirectXrpcClient,
  spaceId: string,
  roomId: string,
  text: string,
  blocks?: Block[],
  parent?: string,
): Promise<{ messageId: string }> {
  return sendMessage(xrpc, spaceId, roomId, text, {
    ...(blocks ? { blocks } : {}),
    ...(parent ? { parent } : {}),
  });
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
