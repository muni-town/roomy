/**
 * Decoding and inspecting message bodies.
 *
 * Kept free of `.svelte` and `@roomy/design` imports so it stays runnable
 * outside a SvelteKit/Vite context — the predicate below decides a rendering
 * behaviour (whether a forward's commentary bubble exists at all) and is
 * covered by `node --test`, which app-lite's CI runs.
 */

import { RICHTEXT_MIME, blocksToPlaintext, isRichTextDocument } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";

/**
 * Parse a new-format message content string into blocks, or `null` when the
 * content isn't a valid richtext document.
 *
 * The appserver's `decodeContent` base64-encodes non-`text/*` mimeTypes, so
 * `message.content` for `application/vnd.roomy.richtext+json` messages is the
 * base64-encoded JSON document — the client must base64-decode before
 * `JSON.parse`. Returns `null` on any parse/validation failure so callers can
 * fall back to the legacy markdown path.
 */
export function parseRichTextContent(content: string): Block[] | null {
  try {
    // The wire document is UTF-8 JSON. atob() returns a binary (Latin-1)
    // string where each byte is its own code point, so re-decode as UTF-8
    // before JSON.parse — otherwise non-ASCII text (ae/oe/aa, curly
    // apostrophes, emoji) comes back as mojibake (e.g. "Ã¦Ã¸Ã¥" for "æøå").
    const binary = atob(content);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(json);
    if (isRichTextDocument(parsed)) return parsed.blocks;
    return null;
  } catch {
    return null;
  }
}

/**
 * Does this message body render anything the user can see?
 *
 * Truthiness of `content` cannot answer this: every rich-text body is the
 * **base64-encoded** blocks document, so an empty document
 * (`{"blocks":[]}`) — or the single empty text block an untouched composer
 * serializes — is a non-empty string. Callers deciding whether to render a
 * body (notably the forwarder's commentary bubble, which must be absent on a
 * bare forward) must ask this instead of testing `content` directly.
 *
 * Mirrors what `BlocksRenderer` actually emits: text-bearing blocks count
 * only when they carry text, while image and horizontal-rule blocks always
 * render an element.
 */
export function messageHasVisibleContent(
  content: string,
  mimeType?: string,
): boolean {
  if (mimeType === RICHTEXT_MIME) {
    const blocks = parseRichTextContent(content);
    if (!blocks) return false;
    if (blocksToPlaintext(blocks) !== "") return true;
    return blocks.some(
      (block) =>
        block.$type === "space.roomy.richtext.blocks#image" ||
        block.$type === "space.roomy.richtext.blocks#horizontalRule",
    );
  }
  // Legacy markdown: blank/whitespace-only bodies render nothing.
  return content.trim() !== "";
}

/**
 * Canonical JSON with object keys sorted, so two structures built by
 * different serializer paths (the stored wire blocks vs the editor's
 * round-trip) compare by shape, not by property order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * Structural equality of two blocks+facets bodies, order-insensitive on
 * object keys. Used by the edit save path to decide "nothing changed", where
 * the submitted blocks come from the editor's round-trip
 * (`blocksToProseMirrorDoc` → `proseMirrorDocToBlocks`) while the stored ones
 * are the wire document — equal in content, not necessarily in key order.
 */
export function richTextBlocksEqual(a: Block[], b: Block[]): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
