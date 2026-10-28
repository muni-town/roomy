/**
 * Tests for the bytes a tile's images are drawn from.
 *
 * The fetches are stubbed: a `plc.directory` document and a PDS blob response
 * are all this module reads from the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetTileImageCacheForTest,
  parseCdnImageUrl,
  tileImageBytes,
} from "./tile-images.js";

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const CID = "bafkreidvywlo2nyrizqs7vy7rl7e4m5hedt75lxq2xcpb4rlljvtyqhck4";
const PDS = "https://pds.example";
const IMAGE = `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/${CID}@jpeg`;

interface Fetched {
  url: string;
}

/** Answer every fetch: the DID document, then the blob the PDS is asked for. */
function stubNetwork(options: { bytes?: Uint8Array; contentType?: string; blobStatus?: number } = {}) {
  const calls: Fetched[] = [];
  const bytes = options.bytes ?? new Uint8Array([1, 2, 3]);
  // `Response` takes an ArrayBuffer; a view's `buffer` is typed as one that may
  // be shared, which it never is here.
  const body = bytes.buffer as ArrayBuffer;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    if (url.startsWith("https://plc.directory/")) {
      return new Response(
        JSON.stringify({
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }],
        }),
      );
    }
    if (url.startsWith(`${PDS}/xrpc/com.atproto.sync.getBlob`)) {
      return new Response(body, {
        status: options.blobStatus ?? 200,
        headers: { "content-type": options.contentType ?? "image/jpeg" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  _resetTileImageCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseCdnImageUrl", () => {
  it("reads the repository and blob a CDN image URL names", () => {
    expect(parseCdnImageUrl(IMAGE)).toEqual({ did: DID, cid: CID });
    expect(
      parseCdnImageUrl(`https://cdn.bsky.app/img/avatar/plain/${DID}/${CID}`),
    ).toEqual({ did: DID, cid: CID });
  });

  it("declines a URL that does not name a blob", () => {
    expect(parseCdnImageUrl("https://example.com/picture.jpg")).toBeNull();
    expect(parseCdnImageUrl(`https://cdn.bsky.app/img/feed_thumbnail/${DID}/${CID}`)).toBeNull();
    expect(parseCdnImageUrl("")).toBeNull();
  });
});

describe("tileImageBytes", () => {
  it("serves an image from the repository that holds it", async () => {
    const calls = stubNetwork();

    const image = await tileImageBytes(IMAGE);

    expect(image?.contentType).toBe("image/jpeg");
    expect([...(image?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.url)).toEqual([
      `https://plc.directory/${DID}`,
      `${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=${encodeURIComponent(CID)}`,
    ]);
  });

  it("answers a repeated request from memory", async () => {
    const calls = stubNetwork();

    await tileImageBytes(IMAGE);
    await tileImageBytes(IMAGE);

    // One DID lookup and one blob fetch, however many frames ask.
    expect(calls.length).toBe(2);
  });

  it("declines a URL it cannot turn into a blob", async () => {
    const calls = stubNetwork();

    expect(await tileImageBytes("https://example.com/picture.jpg")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("declines a blob the repository will not serve", async () => {
    stubNetwork({ blobStatus: 500 });
    expect(await tileImageBytes(IMAGE)).toBeNull();
  });

  it("declines an image larger than a tile is given", async () => {
    stubNetwork({ bytes: new Uint8Array(3 * 1024 * 1024) });
    expect(await tileImageBytes(IMAGE)).toBeNull();
  });

  it("declines a blob that is not an image", async () => {
    stubNetwork({ contentType: "application/octet-stream" });
    expect(await tileImageBytes(IMAGE)).toBeNull();
  });

  it("serves one request per blob however many ask at once", async () => {
    const calls = stubNetwork();

    const images = await Promise.all([tileImageBytes(IMAGE), tileImageBytes(IMAGE), tileImageBytes(IMAGE)]);

    expect(images.every((image) => image !== null)).toBe(true);
    expect(calls.filter((call) => call.url.includes("getBlob")).length).toBe(1);
  });

  it("drops the least recently used image once it is full", async () => {
    const calls = stubNetwork();
    const url = (index: number) => `https://cdn.bsky.app/img/avatar/plain/${DID}/bafkrei${"a".repeat(index + 1)}`;

    for (let index = 0; index < 33; index++) await tileImageBytes(url(index));
    // The first image was pushed out by the 33rd; asking again fetches it.
    const before = calls.length;
    await tileImageBytes(url(0));
    await tileImageBytes(url(32));

    expect(calls.length).toBe(before + 1);
  });

  it("declines a DID whose repository cannot be found", async () => {
    globalThis.fetch = (async () => new Response("gone", { status: 404 })) as typeof fetch;
    expect(await tileImageBytes(IMAGE)).toBeNull();
  });
});
