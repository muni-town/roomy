/**
 * The one `TileMothership` app-lite runs.
 *
 * `TileMothership.init()` installs a `window` message listener and every tile
 * in the page is driven through it: `renderContent()` mounts a shuttle iframe
 * that reports back by `postMessage`, and the mothership answers a shuttle's
 * resource requests by looking the tile up in its own map. Two mothership
 * instances would both receive every shuttle message and both hold half the
 * ids, so the instance is app-wide and created once.
 *
 * The loader packages are browser-only and drag in zip, mime and TOML parsing,
 * so they are imported here — dynamically — rather than at module load:
 * nothing in this file runs until a tile is actually being rendered.
 */

import type { Tile, TileMothership } from "@dasl/tile-loader";
import type * as LoaderCore from "@dasl/tile-loader";
import { TILE_IMAGE_PATH, tileImageBytes } from "./tile-images.js";
// The loader reports nothing about the ids it mints; this is the id its own
// `registerShuttleFrame` returns, spelled out so it outlives the loader's
// generic-free declaration.
/** A shuttle-frame id: what `sendToShuttle` addresses a frame by. */
export type ShuttleId = `${string}-${string}-${string}-${string}-${string}`;

/**
 * A mothership that can attach a tile's frame and say which id it landed on.
 *
 * The id is the loader's own. `Tile.attachIframe` registers the frame and
 * keeps the id to itself, while the loader's title and icon handoff posts to
 * exactly that id — and a payload has to be sent to the same one — so both
 * sides need it back out.
 */
export interface TileFrameMothership extends TileMothership {
  /**
   * Attach `ifr` to `tile` the way the loader does, and return the id its
   * frame was registered under.
   *
   * The frame must be attached through this, not registered directly: the
   * title and icon handoff posts to the id `attachIframe` records, so a frame
   * registered by any other route leaves that id empty and the handoff is
   * posted to nothing.
   */
  attachTileFrame(tile: Tile, ifr: HTMLIFrameElement): ShuttleId;
  /**
   * Drop a frame's registration, so an evicted tile leaves no live frame
   * behind. The loader (2.0.0) has no unregister of its own — its maps are
   * private and only ever grow — so this clears the frame's source, detaches
   * the element and forgets it here. The loader keeps an inert reference to a
   * frame that is no longer in the document, which is as far as its API
   * reaches.
   */
  releaseTileFrame(id: ShuttleId): void;
}

let mothership: TileFrameMothership | undefined;
let loading: Promise<TileFrameMothership> | undefined;

/**
 * Build a mothership over the loader classes `core` provides.
 *
 * It records each registration by overriding `registerShuttleFrame`, which is
 * what `Tile.attachIframe` calls, so the id is read on the loader's own path
 * rather than by minting a second frame id beside it.
 */
export function createTileMothership(core: typeof LoaderCore): TileFrameMothership {
  class FrameTrackingMothership extends core.TileMothership {
    #frameId: ShuttleId | undefined;
    readonly #frames = new Map<ShuttleId, HTMLIFrameElement>();

    override registerShuttleFrame(ifr: HTMLIFrameElement, tile: Tile): ShuttleId {
      const id = super.registerShuttleFrame(ifr, tile);
      this.#frameId = id;
      this.#frames.set(id, ifr);
      return id;
    }

    releaseTileFrame(id: ShuttleId): void {
      const ifr = this.#frames.get(id);
      if (!ifr) return;
      this.#frames.delete(id);
      ifr.src = "about:blank";
      ifr.remove();
    }

    attachTileFrame(tile: Tile, ifr: HTMLIFrameElement): ShuttleId {
      this.#frameId = undefined;
      tile.attachIframe(ifr);
      const id = this.#frameId;
      if (id === undefined) {
        throw new Error("The tile loader attached the frame without registering it.");
      }
      return id;
    }
  }

  return new FrameTrackingMothership();
}

/**
 * Wrap a loader so the images a tile asks for are served from the bytes behind
 * them.
 *
 * The loader's worker answers every request a tile's frame makes — including
 * one for another origin — by resolving its path here, so an image the tile
 * was given by URL arrives on the same route as the tile's own resources. A
 * path under {@link TILE_IMAGE_PATH} carries a percent-encoded image URL; it is
 * answered from {@link tileImageBytes}, and every other path goes to the
 * loader's own resolution unchanged. A host that does not answer the image path
 * leaves the pictures out and draws the text, which is what the tile's markup
 * already allows for.
 */
export function withTileImages(
  loader: LoaderCore.TileLoader,
): LoaderCore.TileLoader {
  return {
    async load(url, mothership) {
      const tile = await loader.load(url, mothership);
      if (!tile) return tile;
      const resolve = tile.resolvePath.bind(tile);
      tile.resolvePath = async (path: string) =>
        (await resolveImagePath(path)) ?? resolve(path);
      return tile;
    },
  };
}

/** The response for an image path, or null when the path is not one. */
async function resolveImagePath(path: string) {
  if (!path.startsWith(TILE_IMAGE_PATH)) return null;
  let url: string;
  try {
    url = decodeURIComponent(path.slice(TILE_IMAGE_PATH.length));
  } catch {
    return { ok: false as const, status: 404, statusText: "Not found" };
  }
  const image = await tileImageBytes(url);
  if (!image) return { ok: false as const, status: 404, statusText: "Not found" };
  return {
    ok: true as const,
    status: 200,
    statusText: "Ok",
    headers: { "content-type": image.contentType },
    body: image.bytes,
  };
}

/**
 * The app's mothership, constructed and initialized on first use.
 *
 * `loadDomain` is deliberately left unset: the mothership then uses the shared
 * loading server (`load.webtil.es`), which is what serves the shuttle and
 * installs the service worker. Roomy runs no loading server of its own.
 *
 * A failed load clears `loading` so a later tile retries instead of inheriting
 * a cached rejection.
 */
export async function getTileMothership(): Promise<TileFrameMothership> {
  if (mothership) return mothership;
  loading ??= (async () => {
    const [core, at] = await Promise.all([
      import("@dasl/tile-loader"),
      import("@dasl/tile-loader/at"),
    ]);
    const instance = createTileMothership(core);
    instance.init();
    instance.addLoader(withTileImages(new at.ATTileLoader()));
    mothership = instance;
    return instance;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = undefined;
    throw err;
  }
}
