/**
 * Rich text converters: ProseMirror JSON ↔ blocks+facets, markdown → blocks,
 * and the wire-encoding helpers.
 *
 * The blocks+facets model (`space.roomy.richtext.*`) is the canonical rich
 * text representation on the wire:
 *
 *   - `proseMirrorDocToBlocks` — the TipTap-native authoring path (the OXA
 *     tree→facets walk). Emits `#didMention` facets for `userMention` nodes,
 *     `#roomRef` + `#link` facets for `channelThreadMention` nodes, and
 *     `#bold`/`#italic`/`#code`/`#strike`/`#link` facets for text marks.
 *   - `blocksToProseMirrorDoc` — the inverse, for re-editing structured
 *     messages in TipTap.
 *   - `markdownToBlocks` — self-contained markdown parser for backfill and
 *     the Discord bridge transition (no `marked` dependency).
 *   - `blocksToPlaintext` / `extractFacetUrls` / `extractMentionDids` /
 *     `extractInternalLinkTargets` — server-side derivations (push bodies,
 *     embed link detection, mention routing, internal-link prefetch).
 *   - `serializeBlocks` / `deserializeBody` — the wire encoding:
 *     `application/vnd.roomy.richtext+json` (UTF-8 JSON).
 *
 * Facet indices are UTF-8 byte offsets (`byteStart` inclusive, `byteEnd`
 * exclusive), matching `app.bsky.richtext.facet#byteSlice`. All byte-offset
 * computation is centralized here — JS strings are UTF-16, so callers must
 * never compute offsets themselves.
 */

import type { Block, Facet, FacetFeature, RichTextDocument } from "../schema/richtext";
import { Did, Ulid, type } from "../schema";

/** MIME type for the blocks+facets wire encoding. */
export const RICHTEXT_MIME = "application/vnd.roomy.richtext+json";

// ─── UTF-8 byte offset helpers ───────────────────────────────────────────

/** UTF-8 byte length of a JS string. */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Convert a UTF-16 code-unit index into a string to the UTF-8 byte offset of
 * the same character boundary. `utf16Index` must be a character boundary
 * (not a lone surrogate).
 */
export function utf16ToUtf8ByteOffset(s: string, utf16Index: number): number {
  return utf8ByteLength(s.slice(0, utf16Index));
}

// ─── ProseMirror JSON structural types (no tiptap dependency) ────────────

export interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  text?: string;
  marks?: ProseMirrorMark[];
}

export type ProseMirrorDoc = ProseMirrorNode;

// ─── Facet construction helpers ───────────────────────────────────────────

function facet(
  byteStart: number,
  byteEnd: number,
  features: FacetFeature[],
): Facet {
  return { index: { byteStart, byteEnd }, features };
}

function linkFeature(uri: string): FacetFeature {
  return { $type: "space.roomy.richtext.facet#link", uri };
}

function didMentionFeature(did: string): FacetFeature {
  return { $type: "space.roomy.richtext.facet#didMention", did };
}

function roomRefFeature(spaceId: string, roomId?: string): FacetFeature {
  return roomId
    ? { $type: "space.roomy.richtext.facet#roomRef", spaceId, roomId }
    : { $type: "space.roomy.richtext.facet#roomRef", spaceId };
}

/**
 * The web origin each hosted appserver serves, keyed by appserver host.
 *
 * A space reference only means something on the appserver that materialises
 * it, so the origin a link may be rooted at depends on which appserver the
 * client talks to: production's world is served at `roomy.space`, staging's
 * at `next.roomy.space`. Any other deployment serves its own web origin,
 * which only the document itself knows.
 */
export const APPSERVER_WEB_ORIGINS: Readonly<Record<string, string>> = {
  "api.roomy.space": "https://roomy.space",
  "api-staging.roomy.space": "https://next.roomy.space",
};

/**
 * The web origin the given appserver serves, or `null` when it is not a
 * hosted Roomy deployment — a self-hosted or local appserver serves the
 * origin the document itself is on.
 *
 * Accepts the appserver's DID (`did:web:api.roomy.space`) or its HTTP(S) /
 * WS(S) origin.
 */
export function webOriginForAppserver(appserver: string): string | null {
  // A `did:web` host may carry a port and a path, percent-encoded.
  const host = appserver.startsWith("did:web:")
    ? (decodeURIComponent(appserver.slice("did:web:".length))
        .split("/")[0]
        ?.split(":")[0] ?? null)
    : (() => {
        try {
          return new URL(appserver).hostname;
        } catch {
          return null;
        }
      })();
  return host === null ? null : (APPSERVER_WEB_ORIGINS[host] ?? null);
}

/**
 * Parse an internal Roomy link href into `{ spaceId, roomId? }`, or `null`.
 *
 * Accepts root-relative paths (`/did:plc:…/roomId` — the app's own origin,
 * which is the caller's to know) and absolute URLs rooted at one of
 * `internalOrigins`. A caller passes the origin the document is served from,
 * plus the origin of the appserver it talks to
 * ({@link webOriginForAppserver}): a `/did:…` path on any other host is a
 * page on that site, not a space this appserver can look up. `/user/…` and
 * other non-space routes are rejected.
 */
export function parseInternalLinkHref(
  href: string,
  internalOrigins: readonly string[] = [],
): { spaceId: string; roomId?: string } | null {
  let path: string;
  // A `/did:…` path on someone else's site is that site's page, not a space
  // in this appserver's world — the DID is whatever that site put there.
  // Treating it as a space reference both fabricates a lookup that 404s and
  // persists the fabrication into the message body, where every later reader
  // repeats it.
  if (href.startsWith("/") && !href.startsWith("//")) {
    path = href;
    // Root-relative hrefs carry query/fragment; only the path is a reference.
    const suffix = path.search(/[?#]/);
    if (suffix !== -1) path = path.slice(0, suffix);
  } else {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (!internalOrigins.includes(url.origin)) return null;
    path = url.pathname;
  }
  const parts = path.split("/").filter(Boolean);
  const spaceId = parts[0];
  if (!spaceId || spaceId === "user") return null;
  // Space IDs are DIDs (did:plc:… / did:web:…); room IDs are ULIDs. Reject
  // anything else so non-space links (app routes like /watch, /blog, /profile,
  // user handles, room names) are never treated as space/room references —
  // otherwise the internal-link prefetch fires 404 summary queries for them.
  if (Did(spaceId) instanceof type.errors) return null;
  const roomId = parts[1];
  if (roomId && Ulid(roomId) instanceof type.errors) return null;
  return roomId ? { spaceId, roomId } : { spaceId };
}

// ─── ProseMirror → blocks ────────────────────────────────────────────────

interface TextRun {
  text: string;
  marks: ProseMirrorMark[];
}

/** Flatten a node's inline content into text runs (marks attached). */
function flattenInline(node: ProseMirrorNode): TextRun[] {
  const runs: TextRun[] = [];
  for (const child of node.content ?? []) {
    if (child.type === "text") {
      runs.push({ text: child.text ?? "", marks: child.marks ?? [] });
    } else if (child.type === "userMention") {
      const label = String(child.attrs?.label ?? child.attrs?.id ?? "");
      runs.push({
        text: `@${label}`,
        marks: [{ type: "userMention", attrs: child.attrs }],
      });
    } else if (child.type === "channelThreadMention") {
      const label = String(child.attrs?.label ?? "");
      runs.push({
        text: `#${label}`,
        marks: [{ type: "channelThreadMention", attrs: child.attrs }],
      });
    } else if (child.type === "hardBreak") {
      // Preserve line breaks within a paragraph as a newline in the block
      // text (otherwise `line1` + hardBreak + `line2` would collapse to
      // `line1line2`).
      runs.push({ text: "\n", marks: [] });
    } else if (child.content) {
      runs.push(...flattenInline(child));
    }
  }
  return runs;
}

/**
 * Convert a run's marks into facet features. Returns `null` when the run has
 * no formatting marks (plain text needs no facet).
 */
function marksToFeatures(
  marks: ProseMirrorMark[],
  text: string,
  internalOrigins: readonly string[],
): FacetFeature[] | null {
  const features: FacetFeature[] = [];
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        features.push({ $type: "space.roomy.richtext.facet#bold" });
        break;
      case "italic":
        features.push({ $type: "space.roomy.richtext.facet#italic" });
        break;
      case "code":
        features.push({ $type: "space.roomy.richtext.facet#code" });
        break;
      case "strike":
        features.push({ $type: "space.roomy.richtext.facet#strikethrough" });
        break;
      case "underline":
        features.push({ $type: "space.roomy.richtext.facet#underline" });
        break;
      case "link": {
        const href = mark.attrs?.href;
        if (typeof href === "string" && href) {
          features.push(linkFeature(href));
          const internal = parseInternalLinkHref(href, internalOrigins);
          if (internal) {
            features.push(roomRefFeature(internal.spaceId, internal.roomId));
          }
        }
        break;
      }
      case "userMention": {
        const did = mark.attrs?.id;
        if (typeof did === "string" && did.startsWith("did:")) {
          features.push(didMentionFeature(did));
        }
        break;
      }
      case "channelThreadMention": {
        const raw = mark.attrs?.id;
        if (typeof raw === "string") {
          try {
            const parsed = JSON.parse(raw) as {
              id?: string;
              space?: string;
            };
            if (parsed.space) {
              // Emit only the `#roomRef` facet. The renderer turns `#roomRef`
              // into a clickable `class="mention"` anchor, so also emitting a
              // `#link` facet over the same byte range would make any renderer
              // emit nested `<a>` tags (invalid HTML that the browser splits
              // into an empty mention + link).
              features.push(roomRefFeature(parsed.space, parsed.id));
            }
          } catch {
            // Malformed mention id — treat as plain text.
          }
        }
        break;
      }
      default:
        break; // unknown marks → plain text
    }
  }
  return features.length > 0 ? features : null;
}

/**
 * Build a text-bearing block from a node's inline content, computing facet
 * byte offsets over the concatenated text.
 */
function textBlockFromInline(
  node: ProseMirrorNode,
  blockType: "space.roomy.richtext.blocks#text" | "space.roomy.richtext.blocks#header" | "space.roomy.richtext.blocks#blockquote" | "space.roomy.richtext.blocks#small",
  extra: Record<string, unknown> = {},
  internalOrigins: readonly string[] = [],
): Block {
  const runs = flattenInline(node);
  const text = runs.map((r) => r.text).join("");
  const facets: Facet[] = [];
  let utf16Offset = 0;
  for (const run of runs) {
    const features = marksToFeatures(run.marks, run.text, internalOrigins);
    if (features && run.text.length > 0) {
      const start = utf16ToUtf8ByteOffset(text, utf16Offset);
      const end = utf16ToUtf8ByteOffset(text, utf16Offset + run.text.length);
      facets.push(facet(start, end, features));
    }
    utf16Offset += run.text.length;
  }
  const base: Record<string, unknown> = { $type: blockType, text };
  if (facets.length > 0) base.facets = facets;
  return { ...base, ...extra } as Block;
}

/** Convert a list node (bulletList/orderedList) into a list block. */
function listBlockFromNode(
  node: ProseMirrorNode,
  blockType: "space.roomy.richtext.blocks#orderedList" | "space.roomy.richtext.blocks#unorderedList",
  internalOrigins: readonly string[] = [],
): Block {
  const items: { text: string; facets?: Facet[] }[] = [];
  for (const listItem of node.content ?? []) {
    if (listItem.type !== "listItem") continue;
    // A listItem contains one or more paragraphs; concatenate their text.
    const runs: TextRun[] = [];
    for (const child of listItem.content ?? []) {
      if (child.content) runs.push(...flattenInline(child));
    }
    const text = runs.map((r) => r.text).join("");
    const facets: Facet[] = [];
    let utf16Offset = 0;
    for (const run of runs) {
      const features = marksToFeatures(run.marks, run.text, internalOrigins);
      if (features && run.text.length > 0) {
        const start = utf16ToUtf8ByteOffset(text, utf16Offset);
        const end = utf16ToUtf8ByteOffset(text, utf16Offset + run.text.length);
        facets.push(facet(start, end, features));
      }
      utf16Offset += run.text.length;
    }
    items.push(facets.length > 0 ? { text, facets } : { text });
  }
  const base: Record<string, unknown> = { $type: blockType, items };
  // An ordered list's first item number lives in `attrs.start`; it is only
  // meaningful when it is not 1 (the default every renderer already applies).
  const start = node.attrs?.start;
  if (
    blockType === "space.roomy.richtext.blocks#orderedList" &&
    typeof start === "number" &&
    Number.isInteger(start) &&
    start >= 1 &&
    start !== 1
  ) {
    base.start = start;
  }
  return base as Block;
}

/**
 * Convert a ProseMirror document (as produced by `editor.getJSON()`) into
 * blocks+facets. Unknown node types are dropped (their text is lost unless
 * the node carries inline content — see `flattenInline`).
 */
export function proseMirrorDocToBlocks(
  doc: ProseMirrorDoc,
  internalOrigins: readonly string[] = [],
): Block[] {
  const blocks: Block[] = [];
  for (const node of doc.content ?? []) {
    switch (node.type) {
      case "paragraph":
        blocks.push(textBlockFromInline(node, "space.roomy.richtext.blocks#text", {}, internalOrigins));
        break;
      case "heading": {
        const level = Number(node.attrs?.level ?? 1);
        blocks.push(
          textBlockFromInline(node, "space.roomy.richtext.blocks#header", {
            level: Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1,
          }, internalOrigins),
        );
        break;
      }
      case "blockquote": {
        // Recover the nesting depth from nested blockquote nodes.
        let depth = 1;
        let inner = node;
        while (
          inner.content?.length === 1 &&
          inner.content[0]?.type === "blockquote"
        ) {
          depth++;
          inner = inner.content[0];
        }
        const block = textBlockFromInline(
          inner,
          "space.roomy.richtext.blocks#blockquote",
          {},
          internalOrigins,
        );
        blocks.push(
          depth > 1
            ? ({ ...block, level: depth } as Block)
            : block,
        );
        break;
      }
      case "smallText":
        blocks.push(textBlockFromInline(node, "space.roomy.richtext.blocks#small", {}, internalOrigins));
        break;
      case "codeBlock": {
        const text = (node.content ?? [])
          .map((c) => c.text ?? "")
          .join("");
        const language = node.attrs?.language;
        blocks.push(
          typeof language === "string" && language
            ? { $type: "space.roomy.richtext.blocks#code", text, language }
            : { $type: "space.roomy.richtext.blocks#code", text },
        );
        break;
      }
      case "bulletList":
        blocks.push(listBlockFromNode(node, "space.roomy.richtext.blocks#unorderedList", internalOrigins));
        break;
      case "orderedList":
        blocks.push(listBlockFromNode(node, "space.roomy.richtext.blocks#orderedList", internalOrigins));
        break;
      case "horizontalRule":
        blocks.push({ $type: "space.roomy.richtext.blocks#horizontalRule" });
        break;
      case "image": {
        const src = node.attrs?.src;
        if (typeof src === "string" && src) {
          const image: Record<string, unknown> = {
            $type: "space.roomy.richtext.blocks#image",
            uri: src,
          };
          if (typeof node.attrs?.alt === "string" && node.attrs.alt) {
            image.alt = node.attrs.alt;
          }
          blocks.push(image as Block);
        }
        break;
      }
      default:
        break; // unknown block types are dropped (open union)
    }
  }
  return blocks;
}

// ─── Blocks → ProseMirror ────────────────────────────────────────────────

/** Sort facets by byteStart (stable for overlapping ranges). */
function sortedFacets(facets: Facet[] | undefined): Facet[] {
  return [...(facets ?? [])].sort((a, b) => a.index.byteStart - b.index.byteStart);
}

/** Map a facet feature to a ProseMirror mark. */
function featureToMark(feature: FacetFeature): ProseMirrorMark | null {
  switch (feature.$type) {
    case "space.roomy.richtext.facet#bold":
      return { type: "bold" };
    case "space.roomy.richtext.facet#italic":
      return { type: "italic" };
    case "space.roomy.richtext.facet#code":
      return { type: "code" };
    case "space.roomy.richtext.facet#strikethrough":
      return { type: "strike" };
    case "space.roomy.richtext.facet#underline":
      return { type: "underline" };
    case "space.roomy.richtext.facet#link": {
      const link = feature as { $type: "space.roomy.richtext.facet#link"; uri: string };
      return { type: "link", attrs: { href: link.uri } };
    }
    case "space.roomy.richtext.facet#didMention": {
      const mention = feature as { $type: "space.roomy.richtext.facet#didMention"; did: string };
      return { type: "userMention", attrs: { id: mention.did } };
    }
    case "space.roomy.richtext.facet#roomRef": {
      const roomRef = feature as {
        $type: "space.roomy.richtext.facet#roomRef";
        spaceId: string;
        roomId?: string;
      };
      const attrs = roomRef.roomId
        ? { id: JSON.stringify({ id: roomRef.roomId, space: roomRef.spaceId }) }
        : { id: JSON.stringify({ space: roomRef.spaceId }) };
      return { type: "channelThreadMention", attrs };
    }
    default:
      return null; // unknown features → plain text
  }
}

/**
 * Split any text node containing `\n` into text + hardBreak nodes, so a
 * newline preserved in block text round-trips back to a hard break in the
 * editor (mirrors `flattenInline`'s hardBreak → `\n` handling).
 */
function splitNewlines(nodes: ProseMirrorNode[]): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  for (const node of nodes) {
    if (node.type === "text" && node.text?.includes("\n")) {
      const parts = node.text.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) out.push({ type: "hardBreak" });
        if (part) {
          out.push(
            node.marks && node.marks.length > 0
              ? { type: "text", text: part, marks: node.marks }
              : { type: "text", text: part },
          );
        }
      });
    } else {
      out.push(node);
    }
  }
  return out;
}

/**
 * Split a block's text into ProseMirror text nodes with marks, applying all
 * facets that cover each segment. Overlapping facets accumulate marks.
 */
function textNodesWithFacets(
  text: string,
  facets: Facet[] | undefined,
): ProseMirrorNode[] {
  if (!facets || facets.length === 0) {
    return splitNewlines(text ? [{ type: "text", text }] : []);
  }
  const sorted = sortedFacets(facets);
  const nodes: ProseMirrorNode[] = [];
  let utf16Pos = 0;
  // Walk segment boundaries: text start, each facet start/end.
  const boundaries = new Set<number>([0, text.length]);
  for (const f of sorted) {
    boundaries.add(utf8ToUtf16Index(text, f.index.byteStart));
    boundaries.add(utf8ToUtf16Index(text, f.index.byteEnd));
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  for (let i = 0; i < ordered.length - 1; i++) {
    const start = ordered[i]!;
    const end = ordered[i + 1]!;
    if (end <= start) continue;
    const segment = text.slice(start, end);
    if (!segment) continue;
    const marks: ProseMirrorMark[] = [];
    for (const f of sorted) {
      const fStart = utf8ToUtf16Index(text, f.index.byteStart);
      const fEnd = utf8ToUtf16Index(text, f.index.byteEnd);
      if (start >= fStart && end <= fEnd) {
        for (const feature of f.features) {
          const mark = featureToMark(feature);
          if (mark) marks.push(mark);
        }
      }
    }
    nodes.push(marks.length > 0 ? { type: "text", text: segment, marks } : { type: "text", text: segment });
  }
  return splitNewlines(nodes);
}

/** Convert a UTF-8 byte offset into a string to a UTF-16 code-unit index.
 *  Inverse of {@link utf16ToUtf8ByteOffset}. Walks the string accumulating
 *  each code unit's UTF-8 byte length and stops when the cumulative length
 *  reaches `byteOffset`. */
export function utf8ToUtf16Index(s: string, byteOffset: number): number {
  const bytes = new TextEncoder().encode(s);
  if (byteOffset <= 0) return 0;
  if (byteOffset >= bytes.length) return s.length;
  let bytePos = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // UTF-8 byte length of the char:
    //   < 0x80       → 1
    //   < 0x800      → 2
    //   U+0800..FFFF → 3
    // An astral char is a UTF-16 surrogate pair (U+D800..U+DFFF each half):
    // 4 bytes total, 2 per half — not 3. A half is a single UTF-16 code
    // unit whose charCode is >= 0x800, so it must be special-cased or the
    // pair is charged 6 bytes and every facet after the char lands one
    // UTF-16 index early per pair (e.g. a link mark swallowing the space
    // before it). Surrogate non-pair values here are invalid UTF-16, but the
    // table degrades them to 2 rather than throwing.
    bytePos += code < 0x80 ? 1 : code >= 0x10000 ? 4 : code >= 0xD800 && code <= 0xDFFF ? 2 : code >= 0x800 ? 3 : 2;
    if (bytePos >= byteOffset) return i + 1;
  }
  return s.length;
}

/** Build a paragraph node from a text-bearing block. */
function paragraphFromTextBlock(
  text: string,
  facets: Facet[] | undefined,
): ProseMirrorNode {
  const content = textNodesWithFacets(text, facets);
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

/**
 * Convert blocks+facets back into a ProseMirror document for re-editing in
 * TipTap. Mention facets reconstruct `userMention` / `channelThreadMention`
 * nodes; link facets reconstruct `link` marks.
 */
export function blocksToProseMirrorDoc(blocks: Block[]): ProseMirrorDoc {
  const content: ProseMirrorNode[] = [];
  for (const block of blocks) {
    switch (block.$type) {
      case "space.roomy.richtext.blocks#text": {
        const textBlock = block as { $type: "space.roomy.richtext.blocks#text"; text: string; facets?: Facet[] };
        content.push(paragraphFromTextBlock(textBlock.text, textBlock.facets));
        break;
      }
      case "space.roomy.richtext.blocks#header": {
        const header = block as { $type: "space.roomy.richtext.blocks#header"; text: string; level: number; facets?: Facet[] };
        content.push({
          type: "heading",
          attrs: { level: header.level },
          content: textNodesWithFacets(header.text, header.facets),
        });
        break;
      }
      case "space.roomy.richtext.blocks#blockquote": {
        const quote = block as { $type: "space.roomy.richtext.blocks#blockquote"; text: string; facets?: Facet[]; level?: number };
        // Nest blockquote nodes by `level` so re-editing preserves the depth.
        const level = Math.max(1, Math.floor(quote.level ?? 1));
        let node: ProseMirrorNode = {
          type: "blockquote",
          content: [paragraphFromTextBlock(quote.text, quote.facets)],
        };
        for (let d = 1; d < level; d++) {
          node = { type: "blockquote", content: [node] };
        }
        content.push(node);
        break;
      }
      case "space.roomy.richtext.blocks#small": {
        const small = block as { $type: "space.roomy.richtext.blocks#small"; text: string; facets?: Facet[] };
        content.push({
          type: "smallText",
          content: textNodesWithFacets(small.text, small.facets),
        });
        break;
      }
      case "space.roomy.richtext.blocks#code": {
        const code = block as { $type: "space.roomy.richtext.blocks#code"; text: string; language?: string };
        content.push({
          type: "codeBlock",
          ...(code.language ? { attrs: { language: code.language } } : {}),
          content: [{ type: "text", text: code.text }],
        });
        break;
      }
      case "space.roomy.richtext.blocks#orderedList":
      case "space.roomy.richtext.blocks#unorderedList": {
        const list = block as {
          $type: "space.roomy.richtext.blocks#orderedList" | "space.roomy.richtext.blocks#unorderedList";
          items: { text: string; facets?: Facet[] }[];
          start?: number;
        };
        const listType =
          list.$type === "space.roomy.richtext.blocks#orderedList"
            ? "orderedList"
            : "bulletList";
        const start = list.start;
        const carriesStart =
          listType === "orderedList" &&
          typeof start === "number" &&
          Number.isInteger(start) &&
          start >= 1;
        content.push({
          type: listType,
          ...(carriesStart ? { attrs: { start } } : {}),
          content: list.items.map((item) => ({
            type: "listItem",
            content: [paragraphFromTextBlock(item.text, item.facets)],
          })),
        });
        break;
      }
      case "space.roomy.richtext.blocks#horizontalRule":
        content.push({ type: "horizontalRule" });
        break;
      case "space.roomy.richtext.blocks#image": {
        const image = block as { $type: "space.roomy.richtext.blocks#image"; uri: string; alt?: string };
        content.push({
          type: "image",
          attrs: {
            src: image.uri,
            ...(image.alt ? { alt: image.alt } : {}),
          },
        });
        break;
      }
      default:
        break; // unknown blocks are dropped
    }
  }
  return { type: "doc", content };
}

// ─── Derivations ─────────────────────────────────────────────────────────


/**
 * Text of a single block, or `""` when it has no string `text`.
 *
 * `deserializeBody` validates only that the decoded document has a `blocks`
 * array — individual blocks are `unknown` at runtime. A stored message can
 * therefore carry a malformed block (e.g. a `#text` block with no `text`
 * field). Pushing that straight into the joined output would coerce
 * `undefined` to the literal "undefined" and corrupt the derived plaintext.
 */
export function blockText(block: { text?: unknown }): string {
  return typeof block.text === "string" ? block.text : "";
}

/**
 * Item text of a list block, or `[]` when `items` is missing / not an array.
 *
 * List blocks are the one derivation shape whose items are traversed, so a
 * malformed one (`items: null`, or absent) would otherwise throw a
 * `TypeError: list.items.map is not a function` mid-derivation. That throw
 * escapes every caller that treats derivation as infallible — the search
 * indexer and backfill sweep catch it per-message and drop the message from
 * the index, and the push evaluator fails the whole notification. Rich text
 * is untrusted stored input, so degrading to "no item text" is correct.
 */
function listItemTexts(block: { items?: unknown }): string[] {
  if (!Array.isArray(block.items)) return [];
  return block.items.map((item) => {
    const text = (item as { text?: unknown } | null)?.text;
    return typeof text === "string" ? text : "";
  });
}

/** Facets of a single block, or `[]` when malformed. */
export function blockFacets(block: { facets?: unknown }): Facet[] {
  return Array.isArray(block.facets) ? (block.facets as Facet[]) : [];
}

/** Facets of a list block's items, flattened. `[]` when malformed. */
function listItemFacets(block: { items?: unknown }): Facet[] {
  if (!Array.isArray(block.items)) return [];
  const out: Facet[] = [];
  for (const item of block.items) out.push(...blockFacets((item ?? {}) as { facets?: unknown }));
  return out;
}

/** Concatenate all block text (for push bodies, character counting). */
export function blocksToPlaintext(blocks: Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.$type) {
      case "space.roomy.richtext.blocks#text":
      case "space.roomy.richtext.blocks#header":
      case "space.roomy.richtext.blocks#blockquote":
      case "space.roomy.richtext.blocks#small":
      case "space.roomy.richtext.blocks#code": {
        parts.push(blockText(block as { text?: unknown }));
        break;
      }
      case "space.roomy.richtext.blocks#orderedList":
      case "space.roomy.richtext.blocks#unorderedList": {
        parts.push(...listItemTexts(block as { items?: unknown }));
        break;
      }
      default:
        break;
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
/** Collect every `#link` facet URI (replaces regex URL extraction). */
export function extractFacetUrls(blocks: Block[]): string[] {
  const urls = new Set<string>();
  const collect = (facets: Facet[] | undefined) => {
    for (const f of facets ?? []) {
      for (const feature of f.features) {
        if (feature.$type === "space.roomy.richtext.facet#link") {
          const link = feature as { $type: "space.roomy.richtext.facet#link"; uri: string };
          urls.add(link.uri);
        }
      }
    }
  };
  for (const block of blocks) {
    switch (block.$type) {
      case "space.roomy.richtext.blocks#text":
      case "space.roomy.richtext.blocks#header":
      case "space.roomy.richtext.blocks#blockquote":
      case "space.roomy.richtext.blocks#small": {
        collect(blockFacets(block as { facets?: unknown }));
        break;
      }
      case "space.roomy.richtext.blocks#orderedList":
      case "space.roomy.richtext.blocks#unorderedList": {
        collect(listItemFacets(block as { items?: unknown }));
        break;
      }
      default:
        break;
    }
  }
  return [...urls];
}

/** Collect every `#didMention` facet DID (replaces the mentions sidecar). */
export function extractMentionDids(blocks: Block[]): string[] {
  const dids = new Set<string>();
  const collect = (facets: Facet[] | undefined) => {
    for (const f of facets ?? []) {
      for (const feature of f.features) {
        if (feature.$type === "space.roomy.richtext.facet#didMention") {
          const mention = feature as { $type: "space.roomy.richtext.facet#didMention"; did: string };
          dids.add(mention.did);
        }
      }
    }
  };
  for (const block of blocks) {
    switch (block.$type) {
      case "space.roomy.richtext.blocks#text":
      case "space.roomy.richtext.blocks#header":
      case "space.roomy.richtext.blocks#blockquote":
      case "space.roomy.richtext.blocks#small": {
        collect(blockFacets(block as { facets?: unknown }));
        break;
      }
      case "space.roomy.richtext.blocks#orderedList":
      case "space.roomy.richtext.blocks#unorderedList": {
        collect(listItemFacets(block as { items?: unknown }));
        break;
      }
      default:
        break;
    }
  }
  return [...dids];
}

/** Collect every `#roomRef` facet target (internal-link prefetch). */
export function extractInternalLinkTargets(
  blocks: Block[],
): { spaceId: string; roomId?: string }[] {
  const targets: { spaceId: string; roomId?: string }[] = [];
  const seen = new Set<string>();
  const collect = (facets: Facet[] | undefined) => {
    for (const f of facets ?? []) {
      for (const feature of f.features) {
        if (feature.$type === "space.roomy.richtext.facet#roomRef") {
          const roomRef = feature as {
            $type: "space.roomy.richtext.facet#roomRef";
            spaceId: string;
            roomId?: string;
          };
          // Only treat a facet as an internal-link target when it names a
          // real (DID, ULID) pair. A stale/malformed facet holding a
          // non-DID `spaceId` (e.g. a Discord channel snowflake or a bare
          // word) would otherwise fan out 404 `getSpaceSummary` prefetches —
          // this mirrors the `parseInternalLinkHref` guard in app-lite so
          // every path that decides "is this a space/room link" agrees.
          if (Did(roomRef.spaceId) instanceof type.errors) continue;
          if (roomRef.roomId && Ulid(roomRef.roomId) instanceof type.errors)
            continue;
          const key = `${roomRef.spaceId}/${roomRef.roomId ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push(
            roomRef.roomId
              ? { spaceId: roomRef.spaceId, roomId: roomRef.roomId }
              : { spaceId: roomRef.spaceId },
          );
        }
      }
    }
  };
  for (const block of blocks) {
    switch (block.$type) {
      case "space.roomy.richtext.blocks#text":
      case "space.roomy.richtext.blocks#header":
      case "space.roomy.richtext.blocks#blockquote":
      case "space.roomy.richtext.blocks#small": {
        collect(blockFacets(block as { facets?: unknown }));
        break;
      }
      case "space.roomy.richtext.blocks#orderedList":
      case "space.roomy.richtext.blocks#unorderedList": {
        collect(listItemFacets(block as { items?: unknown }));
        break;
      }
      default:
        break;
    }
  }
  return targets;
}

// ─── Markdown → blocks (self-contained) ──────────────────────────────────

interface MdLine {
  text: string;
  indent: number;
}

/**
 * Parse a markdown string into blocks+facets. Handles the Roomy message
 * corpus: paragraphs, headings, blockquotes, code fences, bullet/ordered
 * lists, horizontal rules, images, links, bold/italic/code/strike inline
 * formatting. Mentions (`@handle`) are left as plain text — resolving them
 * to DIDs requires context the converter doesn't have.
 */
export function markdownToBlocks(
  md: string,
  internalOrigins: readonly string[] = [],
): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const inlineToBlock = (
    text: string,
    blockType: "space.roomy.richtext.blocks#text" | "space.roomy.richtext.blocks#header" | "space.roomy.richtext.blocks#blockquote" | "space.roomy.richtext.blocks#small",
    extra: Record<string, unknown> = {},
  ): Block => {
    const { text: plain, facets } = parseInline(text, internalOrigins);
    const base: Record<string, unknown> = { $type: blockType, text: plain };
    if (facets.length > 0) base.facets = facets;
    return { ...base, ...extra } as Block;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Blank line → paragraph separator.
    if (trimmed === "") {
      i++;
      continue;
    }

    // Code fence.
    const fence = /^```(\w*)/.exec(trimmed);
    if (fence) {
      const language = fence[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      const text = codeLines.join("\n");
      blocks.push(
        language
          ? { $type: "space.roomy.richtext.blocks#code", text, language }
          : { $type: "space.roomy.richtext.blocks#code", text },
      );
      continue;
    }

    // Horizontal rule.
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      blocks.push({ $type: "space.roomy.richtext.blocks#horizontalRule" });
      i++;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push(
        inlineToBlock(heading[2]!, "space.roomy.richtext.blocks#header", {
          level: heading[1]!.length,
        }),
      );
      i++;
      continue;
    }

    // Small text (Discord `-# small text`).
    const small = /^-\#\s+(.*)$/.exec(trimmed);
    if (small) {
      blocks.push(
        inlineToBlock(small[1]!, "space.roomy.richtext.blocks#small"),
      );
      i++;
      continue;
    }

    // Blockquote. Discord supports `> ` (single-line), `>> ` (nested), and
    // `>>> ` (multi-line: everything until a blank line is quoted).
    if (trimmed.startsWith(">")) {
      // Multi-line blockquote: `>>> text` quotes the rest of this line and
      // every following line until a blank line (or another block construct).
      if (/^>>>/.test(trimmed)) {
        const quoteLines: string[] = [trimmed.replace(/^>>>\s?/, "")];
        i++;
        while (
          i < lines.length &&
          lines[i]!.trim() !== "" &&
          !/^(#{1,6})\s+/.test(lines[i]!.trim()) &&
          !/^```/.test(lines[i]!.trim()) &&
          !/^[-*_]{3,}\s*$/.test(lines[i]!.trim())
        ) {
          quoteLines.push(lines[i]!.trim());
          i++;
        }
        blocks.push(
          inlineToBlock(quoteLines.join(" "), "space.roomy.richtext.blocks#blockquote"),
        );
        continue;
      }

      // Single-line / nested: group consecutive `>`-prefixed lines by their
      // nesting depth (number of leading `>`), emitting one blockquote block
      // per level so nesting is preserved.
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        const t = lines[i]!.trim();
        const level = (t.match(/^>+/) ?? [""])[0]!.length;
        const quoteLines: string[] = [t.replace(/^>+\s?/, "")];
        i++;
        while (
          i < lines.length &&
          lines[i]!.trim().startsWith(">") &&
          (lines[i]!.trim().match(/^>+/) ?? [""])[0]!.length === level
        ) {
          quoteLines.push(lines[i]!.trim().replace(/^>+\s?/, ""));
          i++;
        }
        blocks.push(
          inlineToBlock(quoteLines.join(" "), "space.roomy.richtext.blocks#blockquote", {
            ...(level > 1 ? { level } : {}),
          }),
        );
      }
      continue;
    }

    // Lists.
    const bullet = /^([-*+])\s+(.*)$/.exec(trimmed);
    if (bullet) {
      const items: { text: string; facets?: Facet[] }[] = [];
      while (i < lines.length) {
        const m = /^([-*+])\s+(.*)$/.exec(lines[i]!.trim());
        if (!m) break;
        const { text, facets } = parseInline(m[2]!, internalOrigins);
        items.push(facets.length > 0 ? { text, facets } : { text });
        i++;
      }
      blocks.push({ $type: "space.roomy.richtext.blocks#unorderedList", items });
      continue;
    }
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      const items: { text: string; facets?: Facet[] }[] = [];
      // The first line's number is the list's start; later lines only
      // delimit items (markdown numbering is decorative past the first).
      const start = Number(ordered[1]);
      while (i < lines.length) {
        const m = /^(\d+)[.)]\s+(.*)$/.exec(lines[i]!.trim());
        if (!m) break;
        const { text, facets } = parseInline(m[2]!, internalOrigins);
        items.push(facets.length > 0 ? { text, facets } : { text });
        i++;
      }
      blocks.push(
        Number.isInteger(start) && start > 1
          ? { $type: "space.roomy.richtext.blocks#orderedList", items, start }
          : { $type: "space.roomy.richtext.blocks#orderedList", items },
      );
      continue;
    }

    // Image on its own line.
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(trimmed);
    if (image) {
      const img: Record<string, unknown> = {
        $type: "space.roomy.richtext.blocks#image",
        uri: image[2]!,
      };
      if (image[1]) img.alt = image[1];
      blocks.push(img as Block);
      i++;
      continue;
    }

    // Paragraph: consume until a blank line or a block-level construct.
    const paraLines: string[] = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[i]!.trim()) &&
      !/^-\#\s+/.test(lines[i]!.trim()) &&
      !/^```/.test(lines[i]!.trim()) &&
      !/^>/.test(lines[i]!.trim()) &&
      !/^([-*+])\s+/.test(lines[i]!.trim()) &&
      !/^(\d+)[.)]\s+/.test(lines[i]!.trim()) &&
      !/^[-*_]{3,}\s*$/.test(lines[i]!.trim())
    ) {
      paraLines.push(lines[i]!.trim());
      i++;
    }
    // Join consecutive lines with a newline (not a space) so single-line
    // breaks survive — multiple lines must not collapse into one.
    blocks.push(inlineToBlock(paraLines.join("\n"), "space.roomy.richtext.blocks#text"));
  }

  return blocks;
}

/**
 * Parse inline markdown into plain text + facets. Handles bold, italic,
 * inline code, strikethrough, and links. Facet byte offsets are computed
 * over the final plain text.
 */
function parseInline(
  input: string,
  internalOrigins: readonly string[] = [],
): { text: string; facets: Facet[] } {
  // Tokenize: links, code spans, bold, italic, strike.
  const tokens: { kind: "text" | "link" | "code" | "bold" | "italic" | "strike"; text: string; href?: string }[] = [];
  let rest = input;
  const pattern =
    /!\[(?<imgAlt>[^\]]*)\]\((?<imgUrl>[^)\s]+)(?:\s+"[^"]*")?\)|\[(?<linkText>[^\]]*)\]\((?<linkUrl>[^)\s]+)(?:\s+"[^"]*")?\)|(?<codeDelim>`+)(?<code>[^`]+?)\k<codeDelim>|(?<boldDelim>\*\*|__)(?<bold>.+?)\k<boldDelim>|(?<italicDelim>\*|_)(?<italic>[^*_]+?)\k<italicDelim>|(?<strikeDelim>~~)(?<strike>.+?)\k<strikeDelim>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(rest)) !== null) {
    if (m.index > last) {
      tokens.push({ kind: "text", text: rest.slice(last, m.index) });
    }
    const g = m.groups ?? {};
    if (g.imgUrl !== undefined) {
      // image → keep alt text as plain text
      tokens.push({ kind: "text", text: g.imgAlt ?? "" });
    } else if (g.linkUrl !== undefined) {
      tokens.push({ kind: "link", text: g.linkText ?? "", href: g.linkUrl });
    } else if (g.code !== undefined) {
      tokens.push({ kind: "code", text: g.code });
    } else if (g.bold !== undefined) {
      tokens.push({ kind: "bold", text: g.bold });
    } else if (g.italic !== undefined) {
      tokens.push({ kind: "italic", text: g.italic });
    } else if (g.strike !== undefined) {
      tokens.push({ kind: "strike", text: g.strike });
    }
    last = m.index + m[0].length;
  }
  if (last < rest.length) {
    tokens.push({ kind: "text", text: rest.slice(last) });
  }

  const text = tokens.map((t) => t.text).join("");
  const facets: Facet[] = [];
  let utf16Offset = 0;
  for (const token of tokens) {
    const features: FacetFeature[] = [];
    switch (token.kind) {
      case "bold":
        features.push({ $type: "space.roomy.richtext.facet#bold" });
        break;
      case "italic":
        features.push({ $type: "space.roomy.richtext.facet#italic" });
        break;
      case "code":
        features.push({ $type: "space.roomy.richtext.facet#code" });
        break;
      case "strike":
        features.push({ $type: "space.roomy.richtext.facet#strikethrough" });
        break;
      case "link":
        if (token.href) {
          features.push(linkFeature(token.href));
          const internal = parseInternalLinkHref(token.href, internalOrigins);
          if (internal) {
            features.push(roomRefFeature(internal.spaceId, internal.roomId));
          }
        }
        break;
      default:
        break;
    }
    if (features.length > 0 && token.text.length > 0) {
      const start = utf16ToUtf8ByteOffset(text, utf16Offset);
      const end = utf16ToUtf8ByteOffset(text, utf16Offset + token.text.length);
      facets.push(facet(start, end, features));
    }
    utf16Offset += token.text.length;
  }
  return { text, facets };
}

// ─── Wire encoding ───────────────────────────────────────────────────────

/**
 * Serialize blocks into the wire body: `{ mimeType, data }` with
 * `application/vnd.roomy.richtext+json` and UTF-8 JSON bytes.
 */
export function serializeBlocks(
  blocks: Block[],
): { mimeType: string; data: Uint8Array } {
  const doc: RichTextDocument = {
    $type: "space.roomy.richtext.document",
    blocks,
  };
  return {
    mimeType: RICHTEXT_MIME,
    data: new TextEncoder().encode(JSON.stringify(doc)),
  };
}

/**
 * Decode a wire body into blocks (new mimeType) or a string (legacy
 * mimeTypes). Returns `null` when the body is empty or the JSON is invalid.
 */
export function deserializeBody(
  mime: string | null,
  data: Uint8Array | null,
): Block[] | string | null {
  if (data === null) return null;
  if (mime === RICHTEXT_MIME) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data)) as RichTextDocument;
      if (parsed && Array.isArray(parsed.blocks)) return parsed.blocks;
      return null;
    } catch {
      return null;
    }
  }
  if (!mime || mime.startsWith("text/") || mime === "application/json") {
    return new TextDecoder().decode(data);
  }
  return null;
}
