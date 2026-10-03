import { readdirSync, readFileSync } from "node:fs";
import { BytesWrapper } from "@atcute/cbor";
import { decodeTime } from "ulidx";
import { describe, expect, it } from "vitest";
import { serializeBlocks, utf16ToUtf8ByteOffset } from "../richtext/convert";
import { toBytes } from "../schema/primitives";
import type { Block, FacetFeature } from "../schema/richtext";
import {
  BSKY_POST_MAX_GRAPHEMES,
  countGraphemes,
  roomyMessageToBskyPost,
  type BskyFacet,
  type BskyFacetFeature,
  type RoomyMessage,
} from "./post";

/** A ULID with a fixed decode time, used wherever `createdAt` is asserted. */
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SPACE_DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const USER_DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const ROOM_ID = "01HZBRQMEP2FTE079YRVDFKGTA";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The UTF-8 bytes of `text` in `[byteStart, byteEnd)`, decoded back. */
function sliceUtf8(text: string, byteStart: number, byteEnd: number): string {
  return decoder.decode(encoder.encode(text).slice(byteStart, byteEnd));
}

function richtextMessage(blocks: Block[], id = EVENT_ID): RoomyMessage {
  return { id, body: serializeBlocks(blocks) };
}

function markdownMessage(markdown: string, id = EVENT_ID): RoomyMessage {
  return {
    id,
    body: { mimeType: "text/markdown", data: encoder.encode(markdown) },
  };
}

function bskyLink(uri: string): BskyFacetFeature {
  return { $type: "app.bsky.richtext.facet#link", uri };
}

function bskyMention(did: string): BskyFacetFeature {
  return { $type: "app.bsky.richtext.facet#mention", did };
}

interface Annotation {
  /** Substring of the block text to annotate. */
  at: string;
  features: FacetFeature[];
}

/** A `#text` block with facets computed over the given substrings. */
function annotatedText(text: string, annotations: Annotation[] = []): Block {
  const facets = annotations.map(({ at, features }) => ({
    index: {
      byteStart: utf16ToUtf8ByteOffset(text, text.indexOf(at)),
      byteEnd: utf16ToUtf8ByteOffset(text, text.indexOf(at) + at.length),
    },
    features,
  }));
  const block: Record<string, unknown> = {
    $type: "space.roomy.richtext.blocks#text",
    text,
  };
  if (facets.length > 0) block.facets = facets;
  return block as Block;
}

interface ExpectedFacet {
  /** The substring the facet's byte range must slice out of the post text. */
  slice: string;
  features: BskyFacetFeature[];
}

interface CorpusCase {
  name: string;
  message: RoomyMessage;
  text: string;
  facets: ExpectedFacet[];
}

const CORPUS: CorpusCase[] = [
  {
    name: "plain text block",
    message: richtextMessage([
      { $type: "space.roomy.richtext.blocks#text", text: "hello world" },
    ]),
    text: "hello world",
    facets: [],
  },
  {
    name: "legacy text/plain body",
    message: {
      id: EVENT_ID,
      body: { mimeType: "text/plain", data: encoder.encode("just text") },
    },
    text: "just text",
    facets: [],
  },
  {
    name: "legacy markdown: bold and italic survive as plain text",
    message: markdownMessage("**bold** and *italic* here"),
    text: "bold and italic here",
    facets: [],
  },
  {
    name: "richtext: typography facets dropped, text kept",
    message: richtextMessage([
      annotatedText("bold and italic here", [
        {
          at: "bold",
          features: [{ $type: "space.roomy.richtext.facet#bold" }],
        },
        {
          at: "italic",
          features: [{ $type: "space.roomy.richtext.facet#italic" }],
        },
      ]),
    ]),
    text: "bold and italic here",
    facets: [],
  },
  {
    name: "legacy markdown: link",
    message: markdownMessage("see [example](https://example.com/docs) now"),
    text: "see example now",
    facets: [
      { slice: "example", features: [bskyLink("https://example.com/docs")] },
    ],
  },
  {
    name: "richtext: didMention becomes a bsky mention",
    message: richtextMessage([
      annotatedText("ping @alice please", [
        {
          at: "@alice",
          features: [
            { $type: "space.roomy.richtext.facet#didMention", did: USER_DID },
          ],
        },
      ]),
    ]),
    text: "ping @alice please",
    facets: [{ slice: "@alice", features: [bskyMention(USER_DID)] }],
  },
  {
    name: "richtext: emoji before a link (byte offsets, not UTF-16)",
    message: richtextMessage([
      annotatedText("🌊 wave https://example.com", [
        {
          at: "https://example.com",
          features: [
            {
              $type: "space.roomy.richtext.facet#link",
              uri: "https://example.com",
            },
          ],
        },
      ]),
    ]),
    text: "🌊 wave https://example.com",
    facets: [
      {
        slice: "https://example.com",
        features: [bskyLink("https://example.com")],
      },
    ],
  },
  {
    name: "legacy markdown: internal room link keeps #link, drops #roomRef",
    message: markdownMessage(
      `[lobby](https://roomy.space/${SPACE_DID}/${ROOM_ID})`,
    ),
    text: "lobby",
    facets: [
      {
        slice: "lobby",
        features: [bskyLink(`https://roomy.space/${SPACE_DID}/${ROOM_ID}`)],
      },
    ],
  },
  {
    name: "richtext: a facet whose only feature is #roomRef is dropped",
    message: richtextMessage([
      annotatedText("general", [
        {
          at: "general",
          features: [
            {
              $type: "space.roomy.richtext.facet#roomRef",
              spaceId: SPACE_DID,
            },
          ],
        },
      ]),
    ]),
    text: "general",
    facets: [],
  },
  {
    name: "richtext: #link and #roomRef on one range emit exactly one facet",
    message: richtextMessage([
      annotatedText("lobby", [
        {
          at: "lobby",
          features: [
            {
              $type: "space.roomy.richtext.facet#roomRef",
              spaceId: SPACE_DID,
              roomId: ROOM_ID,
            },
            {
              $type: "space.roomy.richtext.facet#link",
              uri: `https://roomy.space/${SPACE_DID}/${ROOM_ID}`,
            },
          ],
        },
      ]),
    ]),
    text: "lobby",
    facets: [
      {
        slice: "lobby",
        features: [bskyLink(`https://roomy.space/${SPACE_DID}/${ROOM_ID}`)],
      },
    ],
  },
  {
    name: "richtext: unsupported features dropped, sibling #link kept",
    message: richtextMessage([
      annotatedText("see docs and notes", [
        {
          at: "docs",
          features: [
            { $type: "space.roomy.richtext.facet#highlight" },
            {
              $type: "space.roomy.richtext.facet#link",
              uri: "https://example.com",
            },
          ],
        },
        {
          at: "notes",
          features: [
            { $type: "space.roomy.richtext.facet#roomRef", spaceId: SPACE_DID },
            {
              $type: "space.roomy.richtext.facet#atMention",
              uri: `at://${USER_DID}/app.bsky.actor.profile/self`,
            },
            { $type: "space.roomy.richtext.facet#someFutureFeature" },
          ],
        },
      ]),
    ]),
    text: "see docs and notes",
    facets: [{ slice: "docs", features: [bskyLink("https://example.com")] }],
  },
  {
    name: "legacy markdown: fenced code block",
    message: markdownMessage("```js\nconst x = 1;\n```"),
    text: "const x = 1;",
    facets: [],
  },
  {
    name: "legacy markdown: unordered list with a link in the second item",
    message: markdownMessage("* first\n* [second](https://example.com) item"),
    text: "first\nsecond item",
    facets: [{ slice: "second", features: [bskyLink("https://example.com")] }],
  },
  {
    name: "legacy markdown: ordered list",
    message: markdownMessage("1. alpha\n2. beta"),
    text: "alpha\nbeta",
    facets: [],
  },
  {
    name: "richtext: blocks joined with a newline",
    message: richtextMessage([
      { $type: "space.roomy.richtext.blocks#text", text: "one" },
      { $type: "space.roomy.richtext.blocks#header", text: "two", level: 1 },
      { $type: "space.roomy.richtext.blocks#blockquote", text: "three" },
    ]),
    text: "one\ntwo\nthree",
    facets: [],
  },
  {
    name: "richtext: image block contributes no text",
    message: richtextMessage([
      { $type: "space.roomy.richtext.blocks#text", text: "before" },
      {
        $type: "space.roomy.richtext.blocks#image",
        uri: "https://example.com/p.png",
      },
      { $type: "space.roomy.richtext.blocks#text", text: "after" },
    ]),
    text: "before\nafter",
    facets: [],
  },
  {
    name: "empty richtext document",
    message: richtextMessage([]),
    text: "",
    facets: [],
  },
  {
    name: "null body",
    message: { id: EVENT_ID, body: { mimeType: null, data: null } },
    text: "",
    facets: [],
  },
  {
    name: "malformed text block without a text field",
    message: richtextMessage([
      { $type: "space.roomy.richtext.blocks#text" } as unknown as Block,
      { $type: "space.roomy.richtext.blocks#text", text: "after" },
    ]),
    text: "\nafter",
    facets: [],
  },
  {
    name: "malformed list block whose items are not an array",
    message: richtextMessage([
      {
        $type: "space.roomy.richtext.blocks#unorderedList",
        items: null,
      } as unknown as Block,
      { $type: "space.roomy.richtext.blocks#text", text: "after" },
    ]),
    text: "after",
    facets: [],
  },
];

/** Assert the acceptance property: each facet slices out exactly its text. */
function expectFacets(
  text: string,
  facets: BskyFacet[],
  expected: ExpectedFacet[],
): void {
  expect(facets).toHaveLength(expected.length);
  const byteLength = encoder.encode(text).length;
  facets.forEach((facet, i) => {
    const want = expected[i]!;
    expect(facet.index.byteStart).toBeGreaterThanOrEqual(0);
    expect(facet.index.byteEnd).toBeGreaterThan(facet.index.byteStart);
    expect(facet.index.byteEnd).toBeLessThanOrEqual(byteLength);
    expect(sliceUtf8(text, facet.index.byteStart, facet.index.byteEnd)).toBe(
      want.slice,
    );
    expect(facet.features).toEqual(want.features);
  });
}

describe("roomyMessageToBskyPost — corpus", () => {
  for (const c of CORPUS) {
    it(c.name, () => {
      const result = roomyMessageToBskyPost(c.message);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toBe(c.text);
      expectFacets(result.text, result.facets, c.facets);
    });
  }
});

describe("roomyMessageToBskyPost — createdAt", () => {
  it("uses the event ULID's time by default", () => {
    const result = roomyMessageToBskyPost(
      richtextMessage([
        { $type: "space.roomy.richtext.blocks#text", text: "hi" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdAt).toBe(new Date(decodeTime(EVENT_ID)).toISOString());
  });

  it("honours the timestampOverride extension", () => {
    const timestamp = 1700000000000;
    const result = roomyMessageToBskyPost({
      id: EVENT_ID,
      body: serializeBlocks([
        { $type: "space.roomy.richtext.blocks#text", text: "bridged" },
      ]),
      extensions: {
        "space.roomy.extension.timestampOverride.v0": { timestamp },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdAt).toBe(new Date(timestamp).toISOString());
  });

  it("falls back to the ULID time when the override is malformed", () => {
    const result = roomyMessageToBskyPost({
      id: EVENT_ID,
      body: serializeBlocks([
        { $type: "space.roomy.richtext.blocks#text", text: "bridged" },
      ]),
      extensions: { "space.roomy.extension.timestampOverride.v0": {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdAt).toBe(new Date(decodeTime(EVENT_ID)).toISOString());
  });
});

describe("roomyMessageToBskyPost — 300-grapheme limit", () => {
  it("counts graphemes, not code units", () => {
    expect(countGraphemes("")).toBe(0);
    expect(countGraphemes("a".repeat(10))).toBe(10);
    expect(countGraphemes("e\u0301")).toBe(1);
    expect(countGraphemes("👨‍👩‍👧‍👦")).toBe(1);
  });

  it("accepts exactly 300 graphemes", () => {
    const result = roomyMessageToBskyPost(
      richtextMessage([
        { $type: "space.roomy.richtext.blocks#text", text: "a".repeat(300) },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countGraphemes(result.text)).toBe(BSKY_POST_MAX_GRAPHEMES);
  });

  it("refuses 301 graphemes without truncating", () => {
    const result = roomyMessageToBskyPost(
      richtextMessage([
        { $type: "space.roomy.richtext.blocks#text", text: "a".repeat(301) },
      ]),
    );
    expect(result).toEqual({
      ok: false,
      reason: "too-long",
      graphemes: 301,
      maxGraphemes: BSKY_POST_MAX_GRAPHEMES,
    });
  });

  it("counts a family emoji once", () => {
    const at = (n: number) =>
      richtextMessage([
        {
          $type: "space.roomy.richtext.blocks#text",
          text: "👨‍👩‍👧‍👦".repeat(n),
        },
      ]);
    expect(roomyMessageToBskyPost(at(300)).ok).toBe(true);
    const refused = roomyMessageToBskyPost(at(301));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.graphemes).toBe(301);
  });

  it("counts a combining acute sequence once", () => {
    const at = (n: number) =>
      richtextMessage([
        {
          $type: "space.roomy.richtext.blocks#text",
          text: "e\u0301".repeat(n),
        },
      ]);
    expect(roomyMessageToBskyPost(at(300)).ok).toBe(true);
    expect(roomyMessageToBskyPost(at(301)).ok).toBe(false);
  });

  it("counts the flattened text, separator included", () => {
    const result = roomyMessageToBskyPost(
      richtextMessage([
        { $type: "space.roomy.richtext.blocks#text", text: "a".repeat(150) },
        { $type: "space.roomy.richtext.blocks#text", text: "b".repeat(150) },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.graphemes).toBe(301);
  });
});

describe("roomyMessageToBskyPost — byte shapes", () => {
  const blocks: Block[] = [
    {
      $type: "space.roomy.richtext.blocks#text",
      text: "shape check",
      facets: [
        {
          index: { byteStart: 0, byteEnd: 5 },
          features: [
            {
              $type: "space.roomy.richtext.facet#link",
              uri: "https://example.com",
            },
          ],
        },
      ],
    },
  ];
  const expected: ExpectedFacet[] = [
    { slice: "shape", features: [bskyLink("https://example.com")] },
  ];

  it("accepts raw Uint8Array body bytes", () => {
    const wire = serializeBlocks(blocks);
    const result = roomyMessageToBskyPost({ id: EVENT_ID, body: wire });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("shape check");
    expectFacets(result.text, result.facets, expected);
  });

  it("accepts a BytesWrapper body", () => {
    const wire = serializeBlocks(blocks);
    const result = roomyMessageToBskyPost({
      id: EVENT_ID,
      body: { mimeType: wire.mimeType, data: new BytesWrapper(wire.data) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("shape check");
    expectFacets(result.text, result.facets, expected);
  });

  it("accepts a `{$bytes}` body", () => {
    const wire = serializeBlocks(blocks);
    const result = roomyMessageToBskyPost({
      id: EVENT_ID,
      body: { mimeType: wire.mimeType, data: toBytes(wire.data) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("shape check");
    expectFacets(result.text, result.facets, expected);
  });
});

describe("roomyMessageToBskyPost — purity", () => {
  const repoRoot = new URL("../../../../", import.meta.url);
  const MATERIALIZATION_PATHS = [
    "packages/appserver/src/materialization/applyBatch.ts",
    "packages/appserver/src/materialization/applyBundle.ts",
    "packages/appserver/src/handlers/space.roomy.space.sendEvents.ts",
    "packages/app-lite/src/lib/mutations/send-events.ts",
  ];

  it("is not referenced from any materialisation or event-send path", () => {
    for (const path of MATERIALIZATION_PATHS) {
      const source = readFileSync(new URL(path, repoRoot), "utf8");
      expect(source, path).not.toContain("roomyMessageToBskyPost");
      expect(source, path).not.toContain("bluesky/post");
    }
  });

  it("is not referenced anywhere in the materialisation directory", () => {
    const dir = new URL("packages/appserver/src/materialization/", repoRoot);
    const sources = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => readFileSync(new URL(entry.name, dir), "utf8"));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).not.toContain("roomyMessageToBskyPost");
    }
  });

  it("is synchronous and deterministic", () => {
    const message = richtextMessage([
      { $type: "space.roomy.richtext.blocks#text", text: "hello" },
    ]);
    const first = roomyMessageToBskyPost(message);
    const second = roomyMessageToBskyPost(message);
    expect(first).not.toBeInstanceOf(Promise);
    expect(second).toEqual(first);
  });
});
