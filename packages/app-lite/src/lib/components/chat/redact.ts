/**
 * Client-side block redaction over the cached message array.
 *
 * The server redaction is the guarantee: `room.getMessages` returns a
 * tombstone — identity and ordering kept, body and attachments gone — for a
 * hidden author, in both directions. This pass is the belt over it.
 *
 * It exists because the TanStack cache runs on `staleTime: Infinity`: the
 * WebSocket is the sole freshness authority, so a row fetched *before* a block
 * survives in the cache until a `#messageDiff` rewrites it or the query
 * refetches. Blocking someone has to hide them immediately, not on the next
 * page load. The set it consults is therefore the viewer's **own** written
 * blocks (`listBlocks`, § user blocks); the reverse direction cannot be
 * recovered client-side and does not need to be, because the server sends the
 * tombstone for it and the client renders what it is given.
 *
 * `ChatArea` derives the timeline through this pass rather than mutating the
 * cached array, so the cache stays the server's answer and the render is the
 * viewer's.
 *
 * Kept free of Svelte and the DOM so the rule stays unit-testable; `ChatArea`
 * calls it over the query data, exactly like `timeline.ts` next door.
 */

import type { Message } from "$lib/queries/messages";

/**
 * True when `message` is the tombstone the server builds for a hidden author.
 *
 * The structural check is what tells a tombstone from a message whose body is
 * genuinely empty: a real body always carries a `mimeType` (the materialiser
 * writes `comp_content.mime_type` with every content row), while the tombstone
 * omits `mimeType` along with `replyTo`, `forwardedFrom`, `lastEdit` and
 * `system`. The reveal path leans on this: the server answers
 * `message.getMessage` with either the tombstone or the full DTO, and this
 * says which one came back.
 */
export function isBlockedTombstone(message: Message): boolean {
  return (
    message.blocked === true &&
    message.content === "" &&
    message.authorName === "" &&
    message.reactions.length === 0 &&
    message.attachments.length === 0 &&
    message.media.length === 0 &&
    message.linkEmbeds.length === 0 &&
    message.mimeType === undefined &&
    message.replyTo === undefined &&
    message.forwardedFrom === undefined &&
    message.lastEdit === undefined &&
    message.system === undefined
  );
}

/**
 * Rewrite every message whose author the viewer has blocked as the tombstone
 * the server would have sent, leaving the rest untouched.
 *
 * A forward is two authors in one row: the forwarder owns the row, the
 * original owns the body the bubble renders. A blocked original is redacted
 * inside `forwardedFrom.message` — a blocked author's words must not survive
 * by being forwarded by somebody else — while a blocked forwarder redacts the
 * whole row. A row the viewer fetched as a reveal is adopted wholesale,
 * embedded original included: the server already widened that one fetch.
 */
export function redactBlockedAuthors(
  messages: readonly Message[],
  blockedAuthors: ReadonlySet<string>,
  revealed: ReadonlySet<string>,
): Message[] {
  return messages.map((message) => redactOne(message, blockedAuthors, revealed));
}

function redactOne(
  message: Message,
  blockedAuthors: ReadonlySet<string>,
  revealed: ReadonlySet<string>,
): Message {
  if (revealed.has(message.id)) return message;

  const forward = message.forwardedFrom;
  const original = forward?.message;
  const withOriginal =
    original && blockedAuthors.has(original.authorDid)
      ? {
          ...message,
          forwardedFrom: {
            ...forward,
            message: redactOne(original, blockedAuthors, revealed),
          },
        }
      : message;

  if (!blockedAuthors.has(withOriginal.authorDid)) return withOriginal;

  return {
    id: withOriginal.id,
    ...(withOriginal.sort_idx !== undefined
      ? { sort_idx: withOriginal.sort_idx }
      : {}),
    content: "",
    authorDid: withOriginal.authorDid,
    authorName: "",
    timestamp: withOriginal.timestamp,
    blocked: true,
    attachments: [],
    reactions: [],
    media: [],
    linkEmbeds: [],
  };
}
