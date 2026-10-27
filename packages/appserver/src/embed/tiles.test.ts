/**
 * Link-to-tile recognition, projection and resolution.
 *
 * The projection is the part with a contract worth pinning: it is what gets
 * stored per URL and handed to a tile, so its bound and the fields it refuses
 * to carry are behaviour, not formatting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_TILE_DATA_BYTES } from "@roomy-space/sdk";
import {
  BLUESKY_POST_TILE_URI,
  TILE_MAPPING,
  TILE_RESOLVER_VERSION,
  _resetTileCachesForTest,
  projectPost,
  recogniseTileUrl,
  resolveTileForUrl,
  tileAtUri,
  type BlueskyPostTileData,
} from "./tiles.ts";

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const RKEY = "3kabc";

const realFetch = globalThis.fetch;

/** A `getPosts` entry, hydrated the way the public AppView returns one. */
function postView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uri: `at://${DID}/app.bsky.feed.post/${RKEY}`,
    cid: "bafyreiexample",
    author: {
      did: DID,
      handle: "bsky.app",
      displayName: "Bluesky",
      avatar: "https://cdn.bsky.app/avatar.jpg",
    },
    record: {
      $type: "app.bsky.feed.post",
      text: "Hello from a post",
      createdAt: "2026-10-20T10:00:00.000Z",
    },
    likeCount: 12,
    repostCount: 3,
    replyCount: 1,
    quoteCount: 0,
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetTileCachesForTest();
});

describe("recogniseTileUrl", () => {
  test("a handle-form bsky.app post link is recognised without resolving the handle", () => {
    expect(recogniseTileUrl("https://bsky.app/profile/bsky.app/post/3kabc")).toEqual({
      collection: "app.bsky.feed.post",
      rkey: "3kabc",
      handle: "bsky.app",
    });
  });

  test("a DID-form bsky.app post link carries the repo", () => {
    expect(
      recogniseTileUrl(`https://bsky.app/profile/${DID}/post/${RKEY}`),
    ).toEqual({ collection: "app.bsky.feed.post", rkey: RKEY, did: DID });
  });

  test("a bare at:// post URI is recognised", () => {
    expect(recogniseTileUrl(`at://${DID}/app.bsky.feed.post/${RKEY}`)).toEqual({
      collection: "app.bsky.feed.post",
      rkey: RKEY,
      did: DID,
    });
  });

  test("trailing slash and query are not part of the record address", () => {
    expect(recogniseTileUrl("https://bsky.app/profile/bsky.app/post/3kabc/?x=1")).toMatchObject({
      rkey: "3kabc",
    });
  });

  test("a profile link addresses a record this cut maps to no tile", () => {
    expect(recogniseTileUrl("https://bsky.app/profile/bsky.app")).toBeNull();
  });

  test("an at:// URI of a collection with no tile mapping is not recognised", () => {
    expect(recogniseTileUrl(`at://${DID}/app.bsky.actor.profile/self`)).toBeNull();
  });

  test("a URL of another host is not recognised, however post-shaped", () => {
    expect(recogniseTileUrl("https://example.com/profile/bsky.app/post/3kabc")).toBeNull();
    expect(recogniseTileUrl("https://bsky.example/profile/a.b/post/x")).toBeNull();
  });

  test("a record key outside the allowed charset is rejected", () => {
    expect(recogniseTileUrl("https://bsky.app/profile/bsky.app/post/3k abc")).toBeNull();
  });

  test("text that is not a URL is not recognised", () => {
    expect(recogniseTileUrl("not a url")).toBeNull();
    expect(recogniseTileUrl("")).toBeNull();
  });
});

describe("projectPost", () => {
  test("keeps the fields a card draws and drops the rest of the view", () => {
    const projected = projectPost(postView()) as BlueskyPostTileData;
    expect(projected.post).toMatchObject({
      uri: `at://${DID}/app.bsky.feed.post/${RKEY}`,
      author: { did: DID, handle: "bsky.app", displayName: "Bluesky" },
      text: "Hello from a post",
      createdAt: "2026-10-20T10:00:00.000Z",
      counts: { like: 12, repost: 3, reply: 1, quote: 0 },
    });
    // Viewer state, labels and the raw record are not part of the payload.
    expect(projected.post).not.toHaveProperty("record");
    expect(projected.post).not.toHaveProperty("indexedAt");
  });

  test("an empty entry yields no payload at all", () => {
    expect(projectPost({})).toBeUndefined();
    expect(projectPost(null)).toBeUndefined();
  });

  test("the first image embed becomes an image reference", () => {
    const projected = projectPost(
      postView({
        embed: {
          $type: "app.bsky.embed.images#view",
          images: [
            { thumb: "https://cdn.bsky.app/1.jpg", alt: "a cat" },
            { thumb: "https://cdn.bsky.app/2.jpg" },
          ],
        },
      }),
    ) as BlueskyPostTileData;
    expect(projected.post.embed).toEqual({
      kind: "image",
      images: [
        { thumb: "https://cdn.bsky.app/1.jpg", alt: "a cat" },
        { thumb: "https://cdn.bsky.app/2.jpg" },
      ],
    });
  });

  test("a quoted post is reduced to its author and text", () => {
    const projected = projectPost(
      postView({
        embed: {
          $type: "app.bsky.embed.record#view",
          record: {
            uri: `at://${DID}/app.bsky.feed.post/abc`,
            author: { did: DID, handle: "someone.bsky.social", displayName: "Someone" },
            value: { text: "the quoted body" },
          },
        },
      }),
    ) as BlueskyPostTileData;
    expect(projected.post.embed).toEqual({
      kind: "quote",
      uri: `at://${DID}/app.bsky.feed.post/abc`,
      author: { handle: "someone.bsky.social", displayName: "Someone" },
      text: "the quoted body",
    });
  });

  test("a long post is shortened rather than stored unbounded", () => {
    const projected = projectPost(
      postView({ record: { text: "x".repeat(20000), createdAt: "2026-10-20T10:00:00.000Z" } }),
    ) as BlueskyPostTileData;
    const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_TILE_DATA_BYTES);
    expect(projected.post.text.length).toBeGreaterThan(0);
    expect(projected.post.text.length).toBeLessThan(20000);
  });

  test("a post that cannot fit at all loses its payload, not its bound", () => {
    // Ten enormous image alts and a huge text: no truncation of the text alone
    // brings this under the bound, so the projection drops what it can and then
    // gives up rather than storing an oversized row.
    const images = Array.from({ length: 4 }, () => ({
      thumb: "https://cdn.bsky.app/x.jpg",
      alt: "y".repeat(4000),
    }));
    const projected = projectPost(
      postView({
        record: { text: "z".repeat(9000), createdAt: "2026-10-20T10:00:00.000Z" },
        embed: { $type: "app.bsky.embed.images#view", images },
      }),
    );
    if (projected) {
      expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(
        MAX_TILE_DATA_BYTES,
      );
    }
  });
});

describe("tileAtUri", () => {
  test("a DID-form match needs no network", async () => {
    globalThis.fetch = (() => {
      throw new Error("no fetch expected");
    }) as unknown as typeof globalThis.fetch;
    expect(
      await tileAtUri({ collection: "app.bsky.feed.post", rkey: RKEY, did: DID }),
    ).toBe(`at://${DID}/app.bsky.feed.post/${RKEY}`);
  });

  test("a handle-form match resolves the handle and remembers the answer", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ did: DID }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const match = { collection: "app.bsky.feed.post", rkey: RKEY, handle: "bsky.app" };
    expect(await tileAtUri(match)).toBe(`at://${DID}/app.bsky.feed.post/${RKEY}`);
    expect(await tileAtUri(match)).toBe(`at://${DID}/app.bsky.feed.post/${RKEY}`);
    expect(calls).toBe(1);
  });
});

describe("resolveTileForUrl", () => {
  beforeEach(() => {
    _resetTileCachesForTest();
  });

  test("a URL with no tile mapping resolves to nothing", async () => {
    expect(await resolveTileForUrl("https://example.com/a")).toBeNull();
  });

  test("a post resolves to the mapped tile and its projected payload", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/xrpc/app.bsky.feed.getPosts?uris=");
      return new Response(JSON.stringify({ posts: [postView()] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const resolved = await resolveTileForUrl(`https://bsky.app/profile/${DID}/post/${RKEY}`);
    expect(resolved?.status).toBe("ok");
    if (resolved?.status !== "ok") return;
    expect(resolved.tile.url).toBe(BLUESKY_POST_TILE_URI);
    expect(TILE_MAPPING["app.bsky.feed.post"]).toBe(BLUESKY_POST_TILE_URI);
    expect((resolved.tile.data as BlueskyPostTileData).post.text).toBe("Hello from a post");
  });

  test("an empty post list is definitive — the record is not there", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ posts: [] }), { status: 200 })) as unknown as typeof globalThis.fetch;
    expect(await resolveTileForUrl(`https://bsky.app/profile/${DID}/post/${RKEY}`)).toEqual({
      status: "definitive",
    });
  });

  test("a 4xx is definitive and a 5xx is transient", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof globalThis.fetch;
    expect(await resolveTileForUrl(`https://bsky.app/profile/${DID}/post/${RKEY}`)).toEqual({
      status: "definitive",
    });

    globalThis.fetch = (async () =>
      new Response("later", { status: 503 })) as unknown as typeof globalThis.fetch;
    expect(await resolveTileForUrl(`https://bsky.app/profile/${DID}/post/${RKEY}`)).toEqual({
      status: "transient",
    });
  });

  test("a network failure is transient, not a settled row", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await resolveTileForUrl(`https://bsky.app/profile/${DID}/post/${RKEY}`)).toEqual({
      status: "transient",
    });
  });

  test("the resolver version is the one the store is stamped with", () => {
    expect(TILE_RESOLVER_VERSION).toBe(1);
  });
});
