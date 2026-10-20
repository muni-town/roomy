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

import { extractFacetUrls } from "@roomy-space/sdk";
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
