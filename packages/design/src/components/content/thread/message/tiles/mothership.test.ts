/**
 * Tests for the tile mothership's frame attachment.
 *
 * The frames are stubs: `registerShuttleFrame` only stores the element and
 * `sendToShuttle` only posts into `contentWindow`, so nothing here needs a DOM.
 * The mothership and the `Tile` under test are the loader's own classes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@dasl/tile-loader";

import { createTileMothership, withTileImages } from "./mothership.js";
import { _resetTileImageCacheForTest } from "./tile-images.js";

const HELLO = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3meggnybzqs2n";

/** Only the fields the title and icon handoff reads; the loader types the rest. */
const MANIFEST = {
  name: "The Hello Tile",
  description: "An extremely simple tile.",
  icons: [{ src: "/icon.png" }],
};

/** A frame standing in for the shuttle iframe: it records what is posted to it. */
function stubFrame() {
  const posted: unknown[] = [];
  const frame = {
    contentWindow: { postMessage: (message: unknown) => posted.push(message) },
    addEventListener: () => {},
  } as unknown as HTMLIFrameElement;
  return { frame, posted };
}

function loadTile() {
  const mothership = createTileMothership(core);
  const tile = new core.Tile(mothership, HELLO, MANIFEST as never, {
    resolvePath: async () => ({ ok: false, status: 404 }) as never,
  });
  return { mothership, tile };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachTileFrame", () => {
  it("hands the title and icon to the frame the tile was attached to", () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mothership, tile } = loadTile();
    const { frame, posted } = stubFrame();

    const id = mothership.attachTileFrame(tile, frame);
    // The loader's worker announcing it is up: the moment it names the tile.
    tile.dispatchEvent(new Event("load"));

    expect(posted).toEqual([
      { id, action: "tiles-shuttle-set-title", payload: { title: "The Hello Tile" } },
      { id, action: "tiles-shuttle-set-icon", payload: { path: "/icon.png" } },
    ]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("gives the frame an address the payload can be sent to", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mothership, tile } = loadTile();
    const { frame, posted } = stubFrame();

    const id = mothership.attachTileFrame(tile, frame);
    mothership.sendToShuttle(id, "tiles-protocol-down-data-payload", { a: 1 });

    expect(posted).toEqual([
      { id, action: "tiles-protocol-down-data-payload", payload: { a: 1 } },
    ]);
  });

  it("starts the shuttle when the frame loads", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mothership, tile } = loadTile();
    const posted: unknown[] = [];
    let onLoad: (() => void) | undefined;
    const frame = {
      contentWindow: { postMessage: (message: unknown) => posted.push(message) },
      addEventListener: (type: string, handler: () => void) => {
        if (type === "load") onLoad = handler;
      },
    } as unknown as HTMLIFrameElement;

    const id = mothership.attachTileFrame(tile, frame);
    onLoad?.();

    expect(posted).toEqual([{ id, action: "tiles-shuttle-load", payload: { id } }]);
  });
});

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
const CID = "bafkreidvywlo2nyrizqs7vy7rl7e4m5hedt75lxq2xcpb4rlljvtyqhck4";
const IMAGE_URL = `https://cdn.bsky.app/img/feed_thumbnail/plain/${DID}/${CID}`;

/** The loader answers a path with a marker, so a delegation is visible. */
function stubLoader() {
  let asked: string | undefined;
  const loader = {
    async load() {
      return new core.Tile(
        createTileMothership(core),
        HELLO,
        MANIFEST as never,
        {
          async resolvePath(path: string) {
            asked = path;
            return { ok: false, status: 404, statusText: "Not found" } as never;
          },
        },
      );
    },
  };
  return { loader, asked: () => asked };
}

/** The DID document, then whatever the PDS says about the blob. */
function stubNetwork(blob: { status: number; bytes?: Uint8Array }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://plc.directory/")) {
      return new Response(
        JSON.stringify({ service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.example" }] }),
      );
    }
    const bytes = blob.bytes ?? new Uint8Array([7, 8]);
    // `Response` takes an ArrayBuffer; a view's `buffer` is typed as one that
    // may be shared, which it never is here.
    return new Response(bytes.buffer as ArrayBuffer, {
      status: blob.status,
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;
}

describe("withTileImages", () => {
  afterEach(() => {
    _resetTileImageCacheForTest();
    vi.restoreAllMocks();
  });

  it("answers an image path with the bytes behind the URL", async () => {
    stubNetwork({ status: 200 });
    const { loader } = stubLoader();

    const tile = await withTileImages(loader as never).load(HELLO, createTileMothership(core));
    if (!tile) throw new Error("the wrapped loader returned no tile");
    const response = await tile.resolvePath(`/image/${encodeURIComponent(IMAGE_URL)}`);

    expect(response).toMatchObject({ ok: true, status: 200, headers: { "content-type": "image/png" } });
    expect([...(response as { body: Uint8Array }).body]).toEqual([7, 8]);
  });

  it("leaves every other path to the loader's own resolution", async () => {
    stubNetwork({ status: 200 });
    const { loader, asked } = stubLoader();

    const tile = await withTileImages(loader as never).load(HELLO, createTileMothership(core));
    if (!tile) throw new Error("the wrapped loader returned no tile");
    const response = await tile.resolvePath("/tile.js");

    expect(asked()).toBe("/tile.js");
    expect(response).toMatchObject({ ok: false, status: 404 });
  });

  it("declines an image whose bytes cannot be read", async () => {
    stubNetwork({ status: 500 });
    const { loader, asked } = stubLoader();

    const tile = await withTileImages(loader as never).load(HELLO, createTileMothership(core));
    if (!tile) throw new Error("the wrapped loader returned no tile");
    const response = await tile.resolvePath(`/image/${encodeURIComponent(IMAGE_URL)}`);

    expect(response).toMatchObject({ ok: false, status: 404 });
    expect(asked()).toBeUndefined();
  });
});
