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

    override registerShuttleFrame(ifr: HTMLIFrameElement, tile: Tile): ShuttleId {
      const id = super.registerShuttleFrame(ifr, tile);
      this.#frameId = id;
      return id;
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
    instance.addLoader(new at.ATTileLoader());
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
