/**
 * The tile addresses a message body spells out.
 *
 * A tile reaches a message by being written into it: the author drops a tile's
 * AT-URI into the composer and the body carries that string. Nothing is
 * attached and no schema changes — the message is ordinary text, and `ChatMessage`
 * renders a `TileEmbed` beside it for each address found here.
 *
 * Two places can hold the address, because a body has two representations of
 * its text:
 *
 *   - the characters themselves, in a text-bearing block;
 *   - the URI of a link facet, which is where a markdown link
 *     (`[label](at://…)`) keeps its target — the label in the text says nothing
 *     about it.
 *
 * A typed or pasted bare address stays plain text: the composer's autolink
 * (`linkifyjs`) matches `scheme://host` shapes and does not match `at://`, so
 * no facet is produced for it. Both sources are therefore read.
 *
 * Code is skipped. A `#code` block renders its text verbatim, so an address
 * quoted inside one is a sample rather than a tile, and the same holds for a
 * fenced block in a legacy markdown body.
 *
 * The scan is deliberately free of policy beyond "is this a tile": dedupe and
 * the per-message cap live where the result is rendered.
 */

import { RICHTEXT_MIME, extractFacetUrls } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
import { findTileAddresses } from "./at-uri.js";

/**
 * The most tiles one message renders.
 *
 * Every tile costs the reader a `plc.directory` lookup, a record fetch and up
 * to two blob fetches against a PDS chosen by whoever wrote the message, so a
 * body spelling out dozens of addresses would make one message into an
 * amplification vector aimed at every reader of the room. The cap is on
 * rendering, not on the scan: the addresses are still found, they are just not
 * all mounted.
 */
export const MAX_TILES_PER_MESSAGE = 4;

/** The text a block shows, or nothing for a block that is not text-bearing. */
function blockTexts(block: Block): string[] {
  switch (block.$type) {
    case "space.roomy.richtext.blocks#text":
    case "space.roomy.richtext.blocks#header":
    case "space.roomy.richtext.blocks#blockquote":
    case "space.roomy.richtext.blocks#small":
      return [(block as { text?: string }).text ?? ""];
    case "space.roomy.richtext.blocks#orderedList":
    case "space.roomy.richtext.blocks#unorderedList":
      return ((block as { items?: { text?: string }[] }).items ?? []).map(
        (item) => item.text ?? "",
      );
    // `#code` renders verbatim, `#image` and `#horizontalRule` carry no text.
    default:
      return [];
  }
}

/**
 * What a link's own embed carries as a tile: the record to render and the
 * payload it is handed.
 */
export interface LinkTile {
  /** The tile's bare AT-URI. */
  url: string;
  /** The JSON the tile renders. Absent when the resolver had none. */
  data?: unknown;
}

/**
 * The identity of a rendered tile: the record, plus the payload it is handed.
 *
 * One tile record renders many posts, so the record's address alone does not
 * identify a card — two different posts resolved through the same tile are two
 * cards. A body address carries no payload, so it keys on the address alone and
 * collapses with a link resolved to the same record that has nothing to hand
 * it, which is the same card drawn twice.
 */
export function tileRenderKey(uri: string, data: unknown): string {
  return data === undefined ? uri : `${uri}\u0000${JSON.stringify(data)}`;
}

/**
 * Which tiles one message renders, when some come from its body and some from
 * the links in it.
 *
 * Two sources, one cap. A message can spell a tile address in its text and also
 * link a post whose card resolves to a tile — both cost the reader a record
 * fetch and up to two blob fetches, so the cap counts them together rather than
 * twice. The body's addresses come first: they are what the author typed.
 *
 * Returns the body addresses to render and the set of {@link tileRenderKey}s
 * whose link-resolved tile may render, so a caller about to draw a link can ask
 * whether its tile fits.
 */
export function planMessageTiles(
  bodyAddresses: readonly string[],
  links: ReadonlyArray<LinkTile>,
): { addresses: string[]; linkTiles: Set<string> } {
  const addresses: string[] = [];
  const linkTiles = new Set<string>();
  const seen = new Set<string>();

  for (const uri of bodyAddresses) {
    if (addresses.length >= MAX_TILES_PER_MESSAGE) break;
    const key = tileRenderKey(uri, undefined);
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(uri);
  }

  for (const link of links) {
    if (addresses.length + linkTiles.size >= MAX_TILES_PER_MESSAGE) break;
    const key = tileRenderKey(link.url, link.data);
    if (seen.has(key)) continue;
    seen.add(key);
    linkTiles.add(key);
  }

  return { addresses, linkTiles };
}

/** Tile addresses spelled in a rich-text body, in order, without duplicates. */
export function tileAddressesInBlocks(blocks: Block[]): string[] {
  return findTileAddresses(
    ...blocks.flatMap(blockTexts),
    ...extractFacetUrls(blocks),
  );
}

/**
 * A fenced code block — three or more backticks or tildes, to the matching
 * fence. An unclosed fence is not matched and its contents are scanned, which
 * is the harmless direction to be wrong in.
 */
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm;

/** Tile addresses spelled in a legacy markdown body, in order, deduplicated. */
export function tileAddressesInMarkdown(markdown: string): string[] {
  return findTileAddresses(markdown.replace(FENCED_CODE, ""));
}

/**
 * Tile addresses spelled in a message body, in that body's own representation —
 * blocks for a richtext message, markdown for a legacy one. Both sources read
 * the same way, so the branch lives here rather than at each caller.
 */
export function tileAddressesInBody(
  content: string,
  mimeType: string | undefined,
  parseRichText: (content: string) => Block[] | null,
): string[] {
  return mimeType === RICHTEXT_MIME
    ? tileAddressesInBlocks(parseRichText(content) ?? [])
    : tileAddressesInMarkdown(content);
}
