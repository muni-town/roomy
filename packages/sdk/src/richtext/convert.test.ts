import { describe, it, expect } from "vitest";
import {
  proseMirrorDocToBlocks,
  blocksToProseMirrorDoc,
  markdownToBlocks,
  blocksToPlaintext,
} from "./convert";
import type { Block } from "../schema/richtext";

describe("richtext convert — blocks ↔ ProseMirror round-trip", () => {
  it("round-trips a structured doc (header, text, lists) through the editor", () => {
    const blocks: Block[] = [
      { $type: "space.roomy.richtext.blocks#header", text: "Hello", level: 2 },
      { $type: "space.roomy.richtext.blocks#text", text: "Some body text" },
      {
        $type: "space.roomy.richtext.blocks#unorderedList",
        items: [{ text: "a" }, { text: "b" }],
      },
      {
        $type: "space.roomy.richtext.blocks#orderedList",
        items: [{ text: "1" }, { text: "2" }],
      },
    ];

    const doc = blocksToProseMirrorDoc(blocks);
    expect(doc.type).toBe("doc");
    expect(doc.content?.map((n) => n.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
    ]);

    // The editor's own output path must reproduce the same blocks.
    expect(proseMirrorDocToBlocks(doc)).toEqual(blocks);
  });

  it("round-trips a small-text block through the editor", () => {
    const blocks: Block[] = [
      { $type: "space.roomy.richtext.blocks#small", text: "a small caption" },
    ];
    const doc = blocksToProseMirrorDoc(blocks);
    expect(doc.content?.map((n) => n.type)).toEqual(["smallText"]);
    expect(proseMirrorDocToBlocks(doc)).toEqual(blocks);
  });

  it("parses Discord `-# small text` into a small block", () => {
    const blocks = markdownToBlocks("-# a small caption");
    expect(blocks).toEqual([
      { $type: "space.roomy.richtext.blocks#small", text: "a small caption" },
    ]);
  });

  it("preserves single newlines within a paragraph", () => {
    const blocks = markdownToBlocks("line one\nline two\nline three");
    expect(blocks).toEqual([
      { $type: "space.roomy.richtext.blocks#text", text: "line one\nline two\nline three" },
    ]);
  });

  it("parses a Discord `>>>` multi-line blockquote", () => {
    const blocks = markdownToBlocks(">>> line one\nline two\n\nafter");
    expect(blocks).toEqual([
      {
        $type: "space.roomy.richtext.blocks#blockquote",
        text: "line one line two",
      },
      { $type: "space.roomy.richtext.blocks#text", text: "after" },
    ]);
  });

  it("parses a nested `>>` blockquote with level 2", () => {
    const blocks = markdownToBlocks(">> nested quote");
    expect(blocks).toEqual([
      {
        $type: "space.roomy.richtext.blocks#blockquote",
        text: "nested quote",
        level: 2,
      },
    ]);
  });

  it("round-trips a nested blockquote through the editor", () => {
    const blocks: Block[] = [
      { $type: "space.roomy.richtext.blocks#blockquote", text: "outer" },
      { $type: "space.roomy.richtext.blocks#blockquote", text: "inner", level: 2 },
    ];
    const doc = blocksToProseMirrorDoc(blocks);
    expect(doc.content?.[1]?.type).toBe("blockquote");
    expect(doc.content?.[1]?.content?.[0]?.type).toBe("blockquote");
    expect(proseMirrorDocToBlocks(doc)).toEqual(blocks);
  });

  it("preserves newlines as hard breaks when re-parsing a soft break", () => {
    // A single newline (soft break) must survive the editor round-trip as a
    // hard break, not collapse to a space.
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line1" },
            { type: "hardBreak" },
            { type: "text", text: "line2" },
          ],
        },
      ],
    };
    const blocks = proseMirrorDocToBlocks(doc);
    expect(blocksToPlaintext(blocks)).toBe("line1 line2");
    // Re-editing: the hard break becomes a paragraph with a hardBreak node.
    const back = blocksToProseMirrorDoc(blocks);
    expect(back.content?.[0]?.content?.[1]?.type).toBe("hardBreak");
  });

  it("markdownToBlocks parses headers and lists", () => {
    const blocks = markdownToBlocks("# Header\n\n- a\n- b\n\n1. one\n2. two");
    expect(blocks.map((b) => b.$type)).toEqual([
      "space.roomy.richtext.blocks#header",
      "space.roomy.richtext.blocks#unorderedList",
      "space.roomy.richtext.blocks#orderedList",
    ]);
  });

  it("carries a non-1 ordered-list start from the editor into the block", () => {
    // Typing `2. ` makes tiptap set attrs.start = 2 on the orderedList node.
    const doc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 2 },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "item" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(proseMirrorDocToBlocks(doc)).toEqual([
      {
        $type: "space.roomy.richtext.blocks#orderedList",
        items: [{ text: "item" }],
        start: 2,
      },
    ]);
  });

  it("omits start=1, matching the default every renderer already applies", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "item" }] },
              ],
            },
          ],
        },
      ],
    };
    // `start` absent, not `start: 1` — the block stays byte-identical to
    // records written without a `start` field, so both compare equal.
    expect(proseMirrorDocToBlocks(doc)).toEqual([
      {
        $type: "space.roomy.richtext.blocks#orderedList",
        items: [{ text: "item" }],
      },
    ]);
  });

  it("restores a non-1 start when rebuilding the editor doc", () => {
    const doc = blocksToProseMirrorDoc([
      {
        $type: "space.roomy.richtext.blocks#orderedList",
        items: [{ text: "first" }, { text: "second" }],
        start: 2,
      },
    ]);
    expect(doc.content?.[0]?.type).toBe("orderedList");
    expect(doc.content?.[0]?.attrs?.start).toBe(2);
  });

  it("round-trips a non-1 start through both directions", () => {
    const blocks: Block[] = [
      {
        $type: "space.roomy.richtext.blocks#orderedList",
        items: [{ text: "first" }, { text: "second" }],
        start: 2,
      },
      { $type: "space.roomy.richtext.blocks#text", text: "after" },
    ];
    const back = proseMirrorDocToBlocks(blocksToProseMirrorDoc(blocks));
    expect(back).toEqual(blocks);
    // A list with no `start` must stay without one — no `start: 1` invented.
    const plain: Block[] = [
      { $type: "space.roomy.richtext.blocks#orderedList", items: [{ text: "a" }] },
    ];
    expect(proseMirrorDocToBlocks(blocksToProseMirrorDoc(plain))).toEqual(plain);
  });

  it("ignores a malformed start rather than emitting an invalid one", () => {
    // Blocks are `unknown` at runtime (`deserializeBody` only checks that the
    // document has a `blocks` array), so a stored block can carry anything.
    // ProseMirror's orderedList requires start >= 1: degrade, don't propagate.
    for (const start of [0, -3, 1.5, Number.NaN]) {
      const doc = blocksToProseMirrorDoc([
        {
          $type: "space.roomy.richtext.blocks#orderedList",
          items: [{ text: "a" }],
          start,
        } as Block,
      ]);
      expect(doc.content?.[0]?.attrs?.start).toBeUndefined();
    }
  });

  it("takes the ordered list's start from the first markdown line", () => {
    expect(markdownToBlocks("2. first\n3. second")).toEqual([
      {
        $type: "space.roomy.richtext.blocks#orderedList",
        items: [{ text: "first" }, { text: "second" }],
        start: 2,
      },
    ]);
    expect(markdownToBlocks("1. first\n2. second")).toEqual([
      {
        $type: "space.roomy.richtext.blocks#orderedList",
        items: [{ text: "first" }, { text: "second" }],
      },
    ]);
  });

  it("channelThreadMention emits only a #roomRef facet (no nested #link)", () => {
    // A #channel mention must not also carry a `#link` facet over the same
    // range: the renderer turns `#roomRef` into a clickable `class="mention"`
    // anchor, so pairing it with `#link` would emit nested `<a>` tags.
    const blocks = proseMirrorDocToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "channelThreadMention",
              attrs: {
                label: "general",
                id: JSON.stringify({ space: "did:plc:space", id: "room-1" }),
              },
            },
          ],
        },
      ],
    });
    const text = blocks[0] as { text: string; facets?: { features: { $type: string }[] }[] };
    expect(text.text).toBe("#general");
    const facetTypes = text.facets?.[0]?.features.map((f) => f.$type);
    expect(facetTypes).toEqual(["space.roomy.richtext.facet#roomRef"]);
  });

  it("internal room link emits #link + #roomRef (renderer picks one anchor)", () => {
    // A pasted/bare internal room URL keeps both facets — the client renderer
    // applies at most one anchor per slice so they never nest.
    const blocks = proseMirrorDocToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "https://roomy.space/did:plc:drzgt2m6lmcel62gfbzjeap3/01KZBRQMEP2FTE079YRVDFKGTA" },
          ],
        },
      ],
    });
    const text = blocks[0] as { text: string; facets?: { features: { $type: string }[] }[] };
    expect(text.text).toBe("https://roomy.space/did:plc:drzgt2m6lmcel62gfbzjeap3/01KZBRQMEP2FTE079YRVDFKGTA");
    // Plain text has no link mark here; build the mark explicitly to exercise
    // marksToFeatures' link + roomRef path.
    const withLink = proseMirrorDocToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "https://roomy.space/did:plc:drzgt2m6lmcel62gfbzjeap3/01KZBRQMEP2FTE079YRVDFKGTA",
              marks: [{ type: "link", attrs: { href: "/did:plc:drzgt2m6lmcel62gfbzjeap3/01KZBRQMEP2FTE079YRVDFKGTA" } }],
            },
          ],
        },
      ],
    });
    const lt = withLink[0] as { facets?: { features: { $type: string }[] }[] };
    const types = lt.facets?.[0]?.features.map((f) => f.$type);
    expect(types).toContain("space.roomy.richtext.facet#link");
    expect(types).toContain("space.roomy.richtext.facet#roomRef");
  });
});
