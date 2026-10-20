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

import type { TileMothership } from "@dasl/tile-loader";

let mothership: TileMothership | undefined;
let loading: Promise<TileMothership> | undefined;

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
export async function getTileMothership(): Promise<TileMothership> {
  if (mothership) return mothership;
  loading ??= (async () => {
    const [core, at] = await Promise.all([
      import("@dasl/tile-loader"),
      import("@dasl/tile-loader/at"),
    ]);
    const instance = new core.TileMothership();
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
