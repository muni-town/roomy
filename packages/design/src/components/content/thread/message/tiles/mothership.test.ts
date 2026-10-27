/**
 * Tests for the tile mothership's frame attachment.
 *
 * The frames are stubs: `registerShuttleFrame` only stores the element and
 * `sendToShuttle` only posts into `contentWindow`, so nothing here needs a DOM.
 * The mothership and the `Tile` under test are the loader's own classes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@dasl/tile-loader";

import { createTileMothership } from "./mothership.js";

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
