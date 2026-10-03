/**
 * Export a Roomy message to an `app.bsky.feed.post` body.
 *
 * Pure: no network, no clock, no database. The input is the content-bearing
 * part of a `space.roomy.message.createMessage.v0` event; the output is the
 * post's `text`, its `facets` rebased onto that text, and the `createdAt` the
 * record should carry.
 *
 * Both Roomy message wire formats are accepted:
 *
 * - legacy `text/markdown` / `text/plain`, bridged to blocks with
 *   {@link markdownToBlocks};
 * - current `application/vnd.roomy.richtext+json` (blocks + facets), decoded
 *   with {@link deserializeBody}.
 *
 * See `docs/plans/bluesky-publishing.md` §3 for the mapping rules.
 */
import { decodeTime } from "ulidx";
import {
  blockFacets,
  blockText,
  deserializeBody,
  markdownToBlocks,
  utf8ByteLength,
} from "../richtext/convert";
import { fromBytes, type Bytes } from "../schema/primitives";
import type { Block, Facet, FacetFeature } from "../schema/richtext";

/** Bluesky's `app.bsky.feed.post.text` limit, counted in graphemes. */
export const BSKY_POST_MAX_GRAPHEMES = 300;

/**
 * Separator emitted between blocks, and between the items of a list block,
 * when flattening a message to one string. Deterministic so that a message's
 * facet offsets are reproducible.
 */
const BLOCK_SEPARATOR = "\n";

/** Raw body bytes, in any of the shapes they travel in. */
export type RoomyMessageData = Uint8Array | Bytes | null;

/** The content-bearing `body` of a `space.roomy.message.createMessage.v0` event. */
export interface RoomyMessageBody {
  /** `text/markdown`, `text/plain`, or `application/vnd.roomy.richtext+json`. */
  mimeType: string | null;
  /** UTF-8 body bytes. */
  data: RoomyMessageData;
}

/**
 * The `space.roomy.extension.timestampOverride.v0` extension. A producer that
 * translates another system's timeline (the Discord bridge) stamps the
 * original send time with it.
 */
export interface RoomyTimestampOverrideExtension {
  "space.roomy.extension.timestampOverride.v0"?:
    | { timestamp?: number }
    | undefined;
}

/** A Roomy message: the `createMessage.v0` fields this export reads. */
export interface RoomyMessage {
  /** The event's ULID; its time is the fallback for `createdAt`. */
  id: string;
  body: RoomyMessageBody;
  /** The event's extensions. Only `timestampOverride` is read. */
  extensions?: RoomyTimestampOverrideExtension | undefined;
}

/** A Bluesky facet feature: `app.bsky.richtext.facet`'s closed union. */
export type BskyFacetFeature =
  | { $type: "app.bsky.richtext.facet#link"; uri: string }
  | { $type: "app.bsky.richtext.facet#mention"; did: string }
  | { $type: "app.bsky.richtext.facet#tag"; tag: string };

/**
 * A Bluesky facet: a UTF-8 byte range of the whole post's `text` plus the
 * features annotating it. `byteStart` is inclusive, `byteEnd` exclusive.
 */
export interface BskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: BskyFacetFeature[];
}

/** The exported `app.bsky.feed.post` body. */
export interface BskyPostBody {
  text: string;
  facets: BskyFacet[];
  /** ISO-8601 UTC timestamp for the record's `createdAt`. */
  createdAt: string;
}

/**
 * Result of {@link roomyMessageToBskyPost}. Refusal is a value, not a throw:
 * an over-length message is a composer constraint to surface, and a throw
 * would make the exporter unusable from a reactive UI.
 */
export type RoomyMessageToBskyPostResult =
  | ({ ok: true } & BskyPostBody)
  | {
      ok: false;
      reason: "too-long";
      /** Grapheme count of the would-be post text. */
      graphemes: number;
      maxGraphemes: number;
    };

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * Count graphemes in `text`. A family emoji is 1; `e` + a combining acute is
 * 1. This is the unit Bluesky's 300-character post limit is defined in.
 */
export function countGraphemes(text: string): number {
  let count = 0;
  const iterator = graphemeSegmenter.segment(text)[Symbol.iterator]();
  while (!iterator.next().done) count++;
  return count;
}

/** Decode the message body into blocks, whichever wire format it uses. */
function decodeBlocks(message: RoomyMessage): Block[] {
  const decoded = deserializeBody(
    message.body.mimeType,
    bodyBytes(message.body.data),
  );
  // `deserializeBody` returns blocks for the richtext mime type and the
  // decoded UTF-8 string for legacy `text/*` bodies.
  return Array.isArray(decoded) ? decoded : markdownToBlocks(decoded ?? "");
}

/** Normalise the body's byte representation to a `Uint8Array`. */
function bodyBytes(data: RoomyMessageData): Uint8Array | null {
  if (data === null) return null;
  if (data instanceof Uint8Array) return data;
  return fromBytes(data);
}

/** One atomic text unit of a message, with the facets indexing into it. */
interface MessageChunk {
  text: string;
  facets: Facet[];
}

/**
 * Yield a message's text in emission order. Text-bearing blocks and each
 * item of a list block are atomic; blocks with no text representation
 * (`#image`, `#horizontalRule`, unknown `$type`s) are dropped.
 */
function* messageChunks(blocks: Block[]): Generator<MessageChunk> {
  for (const block of blocks) {
    switch (block.$type) {
      case "space.roomy.richtext.blocks#text":
      case "space.roomy.richtext.blocks#header":
      case "space.roomy.richtext.blocks#blockquote":
      case "space.roomy.richtext.blocks#small":
      case "space.roomy.richtext.blocks#code": {
        const b = block as { text?: unknown; facets?: unknown };
        yield { text: blockText(b), facets: blockFacets(b) };
        break;
      }
      case "space.roomy.richtext.blocks#orderedList":
      case "space.roomy.richtext.blocks#unorderedList": {
        const items = (block as { items?: unknown }).items;
        if (!Array.isArray(items)) break;
        for (const item of items) {
          yield {
            text: blockText(item as { text?: unknown }),
            facets: blockFacets(item),
          };
        }
        break;
      }
      default:
        break;
    }
  }
}

/** A chunk placed in the flattened text, at a known byte offset. */
interface FlatSegment {
  /** UTF-8 byte offset of this segment's text in the flattened text. */
  byteStart: number;
  facets: Facet[];
}

/**
 * Flatten a message's blocks to one string, joining chunks with
 * {@link BLOCK_SEPARATOR}, and record where each chunk landed.
 *
 * `blocksToPlaintext` is deliberately not used here: it collapses whitespace
 * and trims, which would destroy the text↔offset correspondence the facet
 * rebase depends on.
 */
function flattenBlocks(blocks: Block[]): {
  text: string;
  segments: FlatSegment[];
} {
  const parts: string[] = [];
  const segments: FlatSegment[] = [];
  let byteStart = 0;
  for (const chunk of messageChunks(blocks)) {
    if (parts.length > 0) byteStart += utf8ByteLength(BLOCK_SEPARATOR);
    parts.push(chunk.text);
    segments.push({ byteStart, facets: chunk.facets });
    byteStart += utf8ByteLength(chunk.text);
  }
  return { text: parts.join(BLOCK_SEPARATOR), segments };
}

/**
 * Map a Roomy facet feature to its Bluesky counterpart, or `null` when
 * Bluesky's closed union has no equivalent.
 *
 * `#link` and `#didMention` translate directly. Typography (`#bold`,
 * `#italic`, `#strikethrough`, `#underline`, `#code`, `#highlight`),
 * `#roomRef`, `#atMention` and unknown features are dropped — their text
 * survives as plain text.
 */
function mapFeature(feature: FacetFeature): BskyFacetFeature | null {
  switch (feature.$type) {
    case "space.roomy.richtext.facet#link": {
      const uri = (feature as { uri?: unknown }).uri;
      return typeof uri === "string"
        ? { $type: "app.bsky.richtext.facet#link", uri }
        : null;
    }
    case "space.roomy.richtext.facet#didMention": {
      const did = (feature as { did?: unknown }).did;
      return typeof did === "string"
        ? { $type: "app.bsky.richtext.facet#mention", did }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Rebase a message's facets onto the flattened text. A facet survives if at
 * least one of its features did; a facet whose features were all dropped — or
 * one that carries nothing — is omitted, so no emitted facet has an empty
 * `features` array.
 */
function rebaseFacets(segments: FlatSegment[]): BskyFacet[] {
  const facets: BskyFacet[] = [];
  for (const segment of segments) {
    for (const source of segment.facets) {
      const index = source?.index;
      if (
        typeof index?.byteStart !== "number" ||
        typeof index?.byteEnd !== "number"
      ) {
        continue;
      }
      const features: BskyFacetFeature[] = [];
      const sourceFeatures = Array.isArray(source.features)
        ? source.features
        : [];
      for (const feature of sourceFeatures) {
        const mapped = mapFeature(feature);
        if (mapped !== null) features.push(mapped);
      }
      if (features.length === 0) continue;
      facets.push({
        index: {
          byteStart: segment.byteStart + index.byteStart,
          byteEnd: segment.byteStart + index.byteEnd,
        },
        features,
      });
    }
  }
  return facets;
}

/**
 * Canonical message time in ms: the `timestampOverride` extension when
 * present, otherwise the event ULID's own time. Mirrors the appserver's
 * `canonicalMessageTimestamp`.
 */
function canonicalMessageTime(message: RoomyMessage): number {
  const override =
    message.extensions?.["space.roomy.extension.timestampOverride.v0"];
  const timestamp = override?.timestamp;
  if (
    typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp > 0
  ) {
    return timestamp;
  }
  return decodeTime(message.id);
}

/**
 * Export a Roomy message as an `app.bsky.feed.post` body, or refuse it for
 * exceeding Bluesky's 300-grapheme text limit.
 *
 * `message.id` must be the createMessage event's ULID.
 */
export function roomyMessageToBskyPost(
  message: RoomyMessage,
): RoomyMessageToBskyPostResult {
  const { text, segments } = flattenBlocks(decodeBlocks(message));
  const graphemes = countGraphemes(text);
  if (graphemes > BSKY_POST_MAX_GRAPHEMES) {
    return {
      ok: false,
      reason: "too-long",
      graphemes,
      maxGraphemes: BSKY_POST_MAX_GRAPHEMES,
    };
  }
  return {
    ok: true,
    text,
    facets: rebaseFacets(segments),
    createdAt: new Date(canonicalMessageTime(message)).toISOString(),
  };
}
