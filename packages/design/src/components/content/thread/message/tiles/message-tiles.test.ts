/**
 * Tests for finding tile addresses in a message body.
 *
 * The failure this defends: an address is prose before it is a record. What
 * arrives in a body has had a full stop, a closing bracket or a quote attached
 * to it by the sentence it sits in, and a markdown body has the target of a
 * link in the facet rather than in the text. A scanner that returns the
 * sentence-punctuated run, or that only reads the text, silently renders no
 * tile for a message that does address one.
 */

import { describe, it, expect } from "vitest";

import { findTileAddresses } from "./at-uri.js";
import {
  MAX_TILES_PER_MESSAGE,
  planMessageTiles,
  tileAddressesInBlocks,
  tileAddressesInMarkdown,
  tileRenderKey,
} from "./message-tiles.js";

const MINESWEEPER = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3mcjwwoqjqs2v";
const HELLO = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3meggnybzqs2n";

/** A `#text` block, the shape a typed body carries. */
function text(text: string, facets?: unknown[]): unknown {
  return {
    $type: "space.roomy.richtext.blocks#text",
    text,
    ...(facets ? { facets } : {}),
  };
}

/** A `#link` facet over the whole of a block's text. */
function linkFacet(uri: string): object {
  return {
    index: { byteStart: 0, byteEnd: 1 },
    features: [{ $type: "space.roomy.richtext.facet#link", uri }],
  };
}

describe("findTileAddresses — prose punctuation", () => {
  it("ends at the punctuation a sentence attaches to a bare address", () => {
    for (const [text, expected] of [
      [`see ${MINESWEEPER}.`, [MINESWEEPER]],
      [`(${MINESWEEPER})`, [MINESWEEPER]],
      [`"${MINESWEEPER}"`, [MINESWEEPER]],
      [`${MINESWEEPER}, and it works`, [MINESWEEPER]],
      [`${MINESWEEPER}!`, [MINESWEEPER]],
      [`<${MINESWEEPER}>`, [MINESWEEPER]],
    ] as const) {
      expect(findTileAddresses(text), text).toEqual([...expected]);
    }
  });

  it("takes back the full stop that is inside a record key's alphabet", () => {
    // The one mark the run cannot end at on its own: `.` is a legal rkey
    // character, so `…/3abc.` lexes as one run.
    expect(findTileAddresses(`posted at ${HELLO}.`)).toEqual([HELLO]);
    expect(findTileAddresses(`posted at ${HELLO}..`)).toEqual([HELLO]);
    // A key that really ends in a dot is not a key this can address anyway —
    // the loader's rkey is a TID — so the trim costs nothing.
  });

  it("ends at a query or fragment the address was spelled with", () => {
    // Both are outside the run's alphabet, so the record address is what comes
    // back; neither can be part of a key.
    expect(findTileAddresses(`${HELLO}?foo=1`)).toEqual([HELLO]);
    expect(findTileAddresses(`${HELLO}#play`)).toEqual([HELLO]);
  });

  it("keeps the two addresses in one body apart", () => {
    expect(findTileAddresses(`${MINESWEEPER} and ${HELLO}`)).toEqual([
      MINESWEEPER,
      HELLO,
    ]);
  });

  it("returns each address once", () => {
    expect(findTileAddresses(`${HELLO} ${HELLO}`)).toEqual([HELLO]);
  });
});

describe("findTileAddresses — what is not a tile", () => {
  it("drops a run that is an address for another collection", () => {
    expect(
      findTileAddresses("at://did:plc:abc/app.bsky.feed.post/3abc")).toEqual([],
    );
  });

  it("drops a run that is not a record address", () => {
    for (const text of [
      "at://did:plc:abc",
      "at://did:plc:abc/ing.dasl.masl",
      `at://did:plc:abc/ing.dasl.masl/3abc/extra`,
      "at://example.com/ing.dasl.masl/3abc",
    ]) {
      expect(findTileAddresses(text), text).toEqual([]);
    }
  });

  it("finds nothing in text with no address at all", () => {
    expect(findTileAddresses("https://example.com/a/b")).toEqual([]);
  });
});

describe("tileAddressesInBlocks", () => {
  it("reads a typed address out of the block text", () => {
    expect(tileAddressesInBlocks([text(`try ${HELLO}`)] as never)).toEqual([
      HELLO,
    ]);
  });

  it("reads the target of a markdown link, which the text does not carry", () => {
    const blocks = [text("the mine game", [linkFacet(MINESWEEPER)])];
    expect(tileAddressesInBlocks(blocks as never)).toEqual([MINESWEEPER]);
  });

  it("reads addresses out of a list's items", () => {
    const blocks = [
      {
        $type: "space.roomy.richtext.blocks#unorderedList",
        items: [{ text: HELLO }, { text: MINESWEEPER }],
      },
    ];
    expect(tileAddressesInBlocks(blocks as never)).toEqual([HELLO, MINESWEEPER]);
  });

  it("skips a code block, where an address is a sample", () => {
    const blocks = [
      { $type: "space.roomy.richtext.blocks#code", text: HELLO },
      text(`and here it is for real: ${HELLO}`),
    ];
    // Found once, from the prose block — not twice, and not from the code.
    expect(tileAddressesInBlocks(blocks as never)).toEqual([HELLO]);
  });
});

describe("tileAddressesInMarkdown", () => {
  it("reads an address out of a legacy body", () => {
    expect(tileAddressesInMarkdown(`try ${HELLO} out`)).toEqual([HELLO]);
  });

  it("skips a fenced code block", () => {
    expect(
      tileAddressesInMarkdown("```\n" + HELLO + "\n```\n\nreal: " + HELLO)).toEqual([HELLO],
    );
    expect(
      tileAddressesInMarkdown("~~~\n" + HELLO + "\n~~~")).toEqual([],
    );
  });

  it("reads a fenced block's own language line as text, not as a fence", () => {
    expect(
      tileAddressesInMarkdown("```" + HELLO + "\n" + HELLO + "\n```")).toEqual([],
    );
  });
});

describe("MAX_TILES_PER_MESSAGE", () => {
  it("caps the tiles one message renders", () => {
    expect(MAX_TILES_PER_MESSAGE).toBe(4);
  });
});

describe("planMessageTiles", () => {
  const TILE = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3bluesky";
  const post = (text: string) => ({ post: { text } });

  it("counts a body address and a link's tile against one cap", () => {
    const body = ["at://did:plc:a/ing.dasl.masl/1", "at://did:plc:a/ing.dasl.masl/2"];
    const links = [
      { url: TILE, data: post("one") },
      { url: TILE, data: post("two") },
      { url: TILE, data: post("three") },
    ];

    const plan = planMessageTiles(body, links);

    // Two from the body, so only two links fit inside the four-tile cap.
    expect(plan.addresses).toEqual(body);
    expect(plan.linkTiles.size).toBe(2);
    expect(plan.linkTiles.has(tileRenderKey(TILE, post("one")))).toBe(true);
    expect(plan.linkTiles.has(tileRenderKey(TILE, post("three")))).toBe(false);
  });

  it("keeps two posts rendered by the same tile apart", () => {
    // One tile record renders many posts: deduping on the address alone would
    // merge them into a single card.
    const plan = planMessageTiles([], [
      { url: TILE, data: post("one") },
      { url: TILE, data: post("two") },
    ]);
    expect(plan.linkTiles.size).toBe(2);
  });

  it("collapses the same render reached from the body and from a link", () => {
    const plan = planMessageTiles([TILE], [{ url: TILE }]);
    expect(plan.addresses).toEqual([TILE]);
    expect(plan.linkTiles.size).toBe(0);
  });

  it("renders nothing past the cap", () => {
    const body = Array.from(
      { length: MAX_TILES_PER_MESSAGE + 2 },
      (_, i) => `at://did:plc:a/ing.dasl.masl/${i}`,
    );
    const plan = planMessageTiles(body, [{ url: TILE, data: post("one") }]);
    expect(plan.addresses).toHaveLength(MAX_TILES_PER_MESSAGE);
    expect(plan.linkTiles.size).toBe(0);
  });

  it("a message with no tiles plans nothing", () => {
    expect(planMessageTiles([], [])).toEqual({ addresses: [], linkTiles: new Set() });
  });
});
