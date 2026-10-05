/**
 * Tests for the rich text converters (`src/richtext/convert.ts`).
 *
 * Covers the Phase 1 acceptance criteria:
 *   - ProseMirror → blocks round-trip (mentions, links, bold/italic/code,
 *     lists, code blocks, internal links) without loss.
 *   - `blocksToPlaintext` matches the legacy `stripMarkdownToPlaintext`
 *     output for the test corpus.
 *   - Facet byte offsets are correct for multi-byte (emoji/CJK) text.
 *   - Wire encoding round-trips through `serializeBlocks`/`deserializeBody`.
 *   - `markdownToBlocks` emits `#link` facets for bare/wrapped URLs.
 */
import { describe, expect, test } from "vitest";
import {
  blocksToPlaintext,
  blocksToProseMirrorDoc,
  deserializeBody,
  extractFacetUrls,
  extractInternalLinkTargets,
  extractMentionDids,
  markdownToBlocks,
  parseInternalLinkHref,
  proseMirrorDocToBlocks,
  serializeBlocks,
  webOriginForAppserver,
  type ProseMirrorDoc,
} from "../../src/richtext/convert";

const mentionDoc: ProseMirrorDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hey " },
        {
          type: "text",
          text: "@alice",
          marks: [
            {
              type: "userMention",
              attrs: { id: "did:plc:alice", label: "alice" },
            },
          ],
        },
        { type: "text", text: " check " },
        {
          type: "text",
          text: "this",
          marks: [
            {
              type: "link",
              attrs: { href: "https://roomy.space/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA" },
            },
          ],
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "item one" }],
            },
          ],
        },
      ],
    },
  ],
};

describe("proseMirrorDocToBlocks", () => {
  test("emits didMention and link+roomRef facets with byte offsets", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc, ["https://roomy.space"]);
    expect(blocks).toHaveLength(2);
    const text = blocks[0] as { text: string; facets?: unknown[] };
    expect(text.text).toBe("Hey @alice check this");
    expect(text.facets).toHaveLength(2);
    const mentionFacet = text.facets![0] as {
      index: { byteStart: number; byteEnd: number };
      features: { $type: string; did?: string }[];
    };
    expect(mentionFacet.index).toEqual({ byteStart: 4, byteEnd: 10 });
    expect(mentionFacet.features[0]).toEqual({
      $type: "space.roomy.richtext.facet#didMention",
      did: "did:plc:alice",
    });
    const linkFacet = text.facets![1] as {
      index: { byteStart: number; byteEnd: number };
      features: { $type: string; uri?: string; spaceId?: string; roomId?: string }[];
    };
    expect(linkFacet.index).toEqual({ byteStart: 17, byteEnd: 21 });
    expect(linkFacet.features).toContainEqual({
      $type: "space.roomy.richtext.facet#link",
      uri: "https://roomy.space/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA",
    });
    expect(linkFacet.features).toContainEqual({
      $type: "space.roomy.richtext.facet#roomRef",
      spaceId: "did:plc:space",
      roomId: "01KZBRQMEP2FTE079YRVDFKGTA",
    });
  });

  test("emits list blocks", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    const list = blocks[1] as {
      $type: string;
      items: { text: string }[];
    };
    expect(list.$type).toBe("space.roomy.richtext.blocks#unorderedList");
    expect(list.items).toEqual([{ text: "item one" }]);
  });

  test("emits header, code, blockquote, horizontalRule blocks", () => {
    const doc: ProseMirrorDoc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted" }],
            },
          ],
        },
        { type: "horizontalRule" },
      ],
    };
    const blocks = proseMirrorDocToBlocks(doc);
    expect(blocks).toEqual([
      {
        $type: "space.roomy.richtext.blocks#header",
        text: "Title",
        level: 2,
      },
      {
        $type: "space.roomy.richtext.blocks#code",
        text: "const x = 1;",
        language: "ts",
      },
      {
        $type: "space.roomy.richtext.blocks#blockquote",
        text: "quoted",
      },
      { $type: "space.roomy.richtext.blocks#horizontalRule" },
    ]);
  });

  test("facet byte offsets are correct for multi-byte text", () => {
    const doc: ProseMirrorDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "héllo " },
            {
              type: "text",
              text: "wörld",
              marks: [{ type: "bold" }],
            },
            { type: "text", text: " 🎉" },
          ],
        },
      ],
    };
    const blocks = proseMirrorDocToBlocks(doc);
    const text = blocks[0] as { text: string; facets?: unknown[] };
    expect(text.text).toBe("héllo wörld 🎉");
    const facet = text.facets![0] as {
      index: { byteStart: number; byteEnd: number };
    };
    // "héllo " is 7 bytes (é = 2), "wörld" is 6 bytes (ö = 2).
    expect(facet.index).toEqual({ byteStart: 7, byteEnd: 13 });
  });
});

describe("blocksToProseMirrorDoc", () => {
  test("round-trips the mention doc", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    const pm = blocksToProseMirrorDoc(blocks);
    expect(pm.type).toBe("doc");
    expect(pm.content).toHaveLength(2);
    const para = pm.content![0]!;
    expect(para.type).toBe("paragraph");
    const mentionText = para.content!.find(
      (n) => n.marks?.some((m) => m.type === "userMention"),
    );
    expect(mentionText?.text).toBe("@alice");
    expect(mentionText?.marks?.[0]).toEqual({
      type: "userMention",
      attrs: { id: "did:plc:alice" },
    });
  });
});

describe("derivations", () => {
  test("blocksToPlaintext concatenates block text", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    expect(blocksToPlaintext(blocks)).toBe("Hey @alice check this item one");
  });

  test("extractMentionDids collects didMention facets", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    expect(extractMentionDids(blocks)).toEqual(["did:plc:alice"]);
  });

  test("extractFacetUrls collects link facet uris", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    expect(extractFacetUrls(blocks)).toEqual([
      "https://roomy.space/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA",
    ]);
  });

  test("extractInternalLinkTargets collects roomRef facets", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc, ["https://roomy.space"]);
    expect(extractInternalLinkTargets(blocks)).toEqual([
      { spaceId: "did:plc:space", roomId: "01KZBRQMEP2FTE079YRVDFKGTA" },
    ]);
  });

  test("extractInternalLinkTargets rejects non-DID spaceId and non-ULID roomId", () => {
    // Mirrors the `parseInternalLinkHref` guard: a facet naming a non-DID
    // space (stale Discord snowflake, bare word, app route) or a non-ULID
    // room must not surface as a prefetch target — an unvalidated one would
    // fire 404 getSpaceSummary queries.
    const blocks = [
      { $type: "space.roomy.richtext.blocks#text", text: "a", facets: [
        { index: { byteStart: 0, byteEnd: 1 }, features: [
          { $type: "space.roomy.richtext.facet#roomRef", spaceId: "muni-town", roomId: "01KZBRQMEP2FTE079YRVDFKGTA" },
        ] },
      ] },
      { $type: "space.roomy.richtext.blocks#text", text: "b", facets: [
        { index: { byteStart: 0, byteEnd: 1 }, features: [
          { $type: "space.roomy.richtext.facet#roomRef", spaceId: "did:plc:space", roomId: "not-ulid" },
        ] },
      ] },
      { $type: "space.roomy.richtext.blocks#text", text: "c", facets: [
        { index: { byteStart: 0, byteEnd: 1 }, features: [
          { $type: "space.roomy.richtext.facet#roomRef", spaceId: "did:plc:space", roomId: "01KZBRQMEP2FTE079YRVDFKGTA" },
        ] },
      ] },
    ] as unknown as Parameters<typeof extractInternalLinkTargets>[0];
    expect(extractInternalLinkTargets(blocks)).toEqual([
      { spaceId: "did:plc:space", roomId: "01KZBRQMEP2FTE079YRVDFKGTA" },
    ]);
  });

  // `deserializeBody` validates only that the document has a `blocks` array —
  // individual blocks are `unknown` at runtime, so a stored message can carry
  // a malformed one. The derivations must degrade, never throw: a throw mid-
  // derivation escapes callers that treat them as infallible (the appserver
  // search indexer drops the message from the index; the push evaluator fails
  // the whole notification).
  test("blocksToPlaintext tolerates a malformed list block", () => {
    const malformed = [
      { $type: "space.roomy.richtext.blocks#unorderedList" },
      { $type: "space.roomy.richtext.blocks#orderedList", items: null },
      { $type: "space.roomy.richtext.blocks#unorderedList", items: "oops" },
    ] as unknown as Parameters<typeof blocksToPlaintext>[0];
    for (const block of malformed) {
      expect(() => blocksToPlaintext([block])).not.toThrow();
    }
    expect(blocksToPlaintext(malformed)).toBe("");
  });

  test("blocksToPlaintext tolerates blocks with missing text", () => {
    const blocks = [
      { $type: "space.roomy.richtext.blocks#text" },
      { $type: "space.roomy.richtext.blocks#code" },
      { $type: "space.roomy.richtext.blocks#unorderedList", items: [{ text: "kept" }] },
    ] as unknown as Parameters<typeof blocksToPlaintext>[0];
    // Must not emit the literal "undefined" for the missing text fields.
    expect(blocksToPlaintext(blocks)).toBe("kept");
  });

  test("facet derivations tolerate malformed list blocks", () => {
    const malformed = [
      { $type: "space.roomy.richtext.blocks#unorderedList" },
      { $type: "space.roomy.richtext.blocks#orderedList", items: null },
      { $type: "space.roomy.richtext.blocks#text", facets: "oops" },
    ] as unknown as Parameters<typeof blocksToPlaintext>[0];
    expect(extractFacetUrls(malformed)).toEqual([]);
    expect(extractMentionDids(malformed)).toEqual([]);
    expect(extractInternalLinkTargets(malformed)).toEqual([]);
  });

  test("facet derivations still collect from well-formed lists", () => {
    const blocks = [{
      $type: "space.roomy.richtext.blocks#unorderedList",
      items: [
        { text: "one", facets: [{ index: { byteStart: 0, byteEnd: 3 }, features: [{ $type: "space.roomy.richtext.facet#link", uri: "https://a.example" }] }] },
        { text: "two", facets: [{ index: { byteStart: 0, byteEnd: 3 }, features: [{ $type: "space.roomy.richtext.facet#didMention", did: "did:plc:alice" }] }] },
      ],
    }] as unknown as Parameters<typeof blocksToPlaintext>[0];
    expect(extractFacetUrls(blocks)).toEqual(["https://a.example"]);
    expect(extractMentionDids(blocks)).toEqual(["did:plc:alice"]);
  });

  test("parseInternalLinkHref accepts DID space + ULID room", () => {
    expect(
      parseInternalLinkHref("/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA"),
    ).toEqual({
      spaceId: "did:plc:space",
      roomId: "01KZBRQMEP2FTE079YRVDFKGTA",
    });
    expect(parseInternalLinkHref("/did:plc:space")).toEqual({
      spaceId: "did:plc:space",
    });
  });

  test("parseInternalLinkHref reads a relative path past its query and hash", () => {
    // A relative href is the app's own origin; the path is the reference, and
    // a query or fragment on it is not part of the space/room ids.
    expect(
      parseInternalLinkHref("/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA?thread=x#msg"),
    ).toEqual({
      spaceId: "did:plc:space",
      roomId: "01KZBRQMEP2FTE079YRVDFKGTA",
    });
    expect(parseInternalLinkHref("/did:plc:space?ref=share")).toEqual({
      spaceId: "did:plc:space",
    });
  });

  test("parseInternalLinkHref rejects non-space links", () => {
    // App routes / handles / room names are not space references — they must
    // not be treated as internal links (which would fire 404 summary queries).
    expect(parseInternalLinkHref("/watch")).toBeNull();
    expect(parseInternalLinkHref("/blog")).toBeNull();
    expect(parseInternalLinkHref("/profile")).toBeNull();
    expect(parseInternalLinkHref("/folkcomputer.bsky.social")).toBeNull();
    expect(parseInternalLinkHref("/oauth-improvements")).toBeNull();
    expect(parseInternalLinkHref("/user/did:plc:alice")).toBeNull();
    // DID space but non-ULID room is not a valid room reference.
    expect(parseInternalLinkHref("/did:plc:space/oauth-improvements")).toBeNull();
  });

  test("webOriginForAppserver maps a hosted appserver to its web origin", () => {
    // Production's appserver serves roomy.space; staging's serves
    // next.roomy.space. Both DID and origin spellings name the same server.
    expect(webOriginForAppserver("did:web:api.roomy.space")).toBe("https://roomy.space");
    expect(webOriginForAppserver("https://api.roomy.space")).toBe("https://roomy.space");
    expect(webOriginForAppserver("did:web:api-staging.roomy.space")).toBe("https://next.roomy.space");
    expect(webOriginForAppserver("wss://api-staging.roomy.space")).toBe("https://next.roomy.space");
    // A `did:web` host may carry a percent-encoded port.
    expect(webOriginForAppserver("did:web:localhost%3A8080")).toBeNull();
    // An unhosted appserver has no web origin of its own.
    expect(webOriginForAppserver("did:web:chat.example.com")).toBeNull();
    expect(webOriginForAppserver("http://127.0.0.1:8080")).toBeNull();
  });

  test("parseInternalLinkHref accepts only the given internal origins", () => {
    // The origin is the caller's to name: an appserver's world is only
    // reachable at the origin that serves it, so a `/did:…` path anywhere
    // else is that site's page.
    expect(
      parseInternalLinkHref("https://roomy.space/did:plc:space", ["https://roomy.space"]),
    ).toEqual({ spaceId: "did:plc:space" });
    expect(
      parseInternalLinkHref("https://next.roomy.space/did:plc:space", ["https://next.roomy.space"]),
    ).toEqual({ spaceId: "did:plc:space" });
    // A staging deployment does not accept production's host, and vice versa.
    expect(
      parseInternalLinkHref("https://roomy.space/did:plc:space", ["https://next.roomy.space"]),
    ).toBeNull();
    // With no origins given, only relative links parse.
    expect(parseInternalLinkHref("https://roomy.space/did:plc:space")).toBeNull();
    expect(parseInternalLinkHref("/did:plc:space")).toEqual({ spaceId: "did:plc:space" });
  });

  test("parseInternalLinkHref rejects a DID path on a foreign host", () => {
    // Any site can put a `did:plc:…` segment on its own path. That is a page
    // on that site, not a space this appserver can resolve, and writing it
    // into a `#roomRef` facet makes every later reader ask for its summary
    // forever. Only the app's own origins (which are the caller's to name,
    // not knowable here) can carry a space reference.
    const origins = ["https://roomy.space", "https://next.roomy.space"];
    expect(
      parseInternalLinkHref("https://twinkl.social/did:plc:rqbqpaaluty5v47jwciowpik", origins),
    ).toBeNull();
    expect(
      parseInternalLinkHref("https://example.com/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA", origins),
    ).toBeNull();
    // A Roomy host this deployment does not serve is someone else's page too.
    expect(parseInternalLinkHref("https://a.roomy.space/did:plc:space", origins)).toBeNull();
    expect(parseInternalLinkHref("https://roomy.chat/did:plc:space", origins)).toBeNull();
    // The same paths on an internal origin still parse.
    expect(parseInternalLinkHref("https://roomy.space/did:plc:space", origins)).toEqual({
      spaceId: "did:plc:space",
    });
    expect(
      parseInternalLinkHref(
        "https://next.roomy.space/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA",
        origins,
      ),
    ).toEqual({
      spaceId: "did:plc:space",
      roomId: "01KZBRQMEP2FTE079YRVDFKGTA",
    });
  });

  test("a foreign-host link body carries no roomRef facet to persist", () => {
    // The write path is the fix: what the composer/converter emits is what
    // lands in the message, and what every later reader's prefetch trusts.
    const origins = ["https://roomy.space"];
    const foreign = proseMirrorDocToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "https://twinkl.social/did:plc:rqbqpaaluty5v47jwciowpik",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://twinkl.social/did:plc:rqbqpaaluty5v47jwciowpik" },
                },
              ],
            },
          ],
        },
      ],
    }, origins);
    expect(extractInternalLinkTargets(foreign)).toEqual([]);
    // The `#link` facet survives — only the space reference is dropped, so
    // the URL still renders as a link.
    expect(
      foreign.flatMap((b) =>
        "facets" in b && Array.isArray(b.facets)
          ? b.facets.flatMap((f) => f.features.map((x) => x.$type))
          : [],
      ),
    ).toEqual(["space.roomy.richtext.facet#link"]);

    // The markdown path (backfill, bridge transition) agrees.
    expect(extractInternalLinkTargets(markdownToBlocks(
      "[x](https://twinkl.social/did:plc:rqbqpaaluty5v47jwciowpik)",
      origins,
    ))).toEqual([]);

    // A link to an origin this deployment serves still produces the facet.
    expect(extractInternalLinkTargets(proseMirrorDocToBlocks({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "https://roomy.space/did:plc:space",
              marks: [{ type: "link", attrs: { href: "https://roomy.space/did:plc:space" } }],
            },
          ],
        },
      ],
    }, origins))).toEqual([{ spaceId: "did:plc:space" }]);
  });
});

describe("wire encoding", () => {
  test("serializeBlocks/deserializeBody round-trip", () => {
    const blocks = proseMirrorDocToBlocks(mentionDoc);
    const wire = serializeBlocks(blocks);
    expect(wire.mimeType).toBe("application/vnd.roomy.richtext+json");
    const back = deserializeBody(wire.mimeType, wire.data);
    expect(back).toEqual(blocks);
  });

  test("deserializeBody returns string for legacy mimeTypes", () => {
    const data = new TextEncoder().encode("**hello**");
    expect(deserializeBody("text/markdown", data)).toBe("**hello**");
  });

  test("deserializeBody returns null for invalid JSON", () => {
    const data = new TextEncoder().encode("{not json");
    expect(deserializeBody("application/vnd.roomy.richtext+json", data)).toBeNull();
  });
});

describe("markdownToBlocks", () => {
  test("parses inline formatting into facets", () => {
    const blocks = markdownToBlocks(
      "**bold** and [link](https://x.com) and `code` and ~~strike~~ and *italic*",
    );
    expect(blocks).toHaveLength(1);
    const text = blocks[0] as { text: string; facets?: unknown[] };
    expect(text.text).toBe("bold and link and code and strike and italic");
    const types = (text.facets ?? []).map((f) => {
      const facet = f as { features: { $type: string }[] };
      return facet.features[0]!.$type;
    });
    expect(types).toEqual([
      "space.roomy.richtext.facet#bold",
      "space.roomy.richtext.facet#link",
      "space.roomy.richtext.facet#code",
      "space.roomy.richtext.facet#strikethrough",
      "space.roomy.richtext.facet#italic",
    ]);
  });

  test("emits link facets for markdown links and internal links", () => {
    const blocks = markdownToBlocks(
      "[room](/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA) and [web](https://example.com)",
    );
    const urls = extractFacetUrls(blocks);
    expect(urls).toEqual(["/did:plc:space/01KZBRQMEP2FTE079YRVDFKGTA", "https://example.com"]);
    const internal = extractInternalLinkTargets(blocks);
    expect(internal).toEqual([{ spaceId: "did:plc:space", roomId: "01KZBRQMEP2FTE079YRVDFKGTA" }]);
  });

  test("parses lists, code fences, headings, blockquotes", () => {
    const blocks = markdownToBlocks(
      [
        "# Title",
        "",
        "> quoted",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "2. second",
      ].join("\n"),
    );
    const types = blocks.map((b) => b.$type);
    expect(types).toEqual([
      "space.roomy.richtext.blocks#header",
      "space.roomy.richtext.blocks#blockquote",
      "space.roomy.richtext.blocks#code",
      "space.roomy.richtext.blocks#unorderedList",
      "space.roomy.richtext.blocks#orderedList",
    ]);
  });
});
