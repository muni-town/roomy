/**
 * Appserver data-directory path resolution.
 *
 * All SQLite DBs and the per-stream DID signing keys live under a single data
 * directory, configured via `DATA_DIR` (default `data`). No per-file env
 * overrides — `DATA_DIR` is the only knob.
 *
 * Layout:
 *   DATA_DIR/
 *   ├── roomy-events.sqlite       (event log; also holds per-stream DID signing keys)
 *   ├── roomy-readstate.sqlite    (read state)
 *   ├── global.sqlite             (global DB)
 *   ├── spaces/                   (per-space DBs)
 *   └── appserver-signing-key.hex (appserver signing key for self-signed serviceAuth)
 */

import { join } from "node:path";

/** Resolve the appserver data directory. Defaults to `DATA_DIR` or `data`. */
export function dataDir(): string {
  return process.env.DATA_DIR ?? "data";
}

/** Resolve a DB file path under the data dir. `DATA_DIR=:memory:` ⇒ `:memory:`. */
export function dbPath(filename: string): string {
  const dir = dataDir();
  return dir === ":memory:" ? ":memory:" : join(dir, filename);
}

/** Resolve the per-space DBs directory. `DATA_DIR=:memory:` ⇒ `:memory:`. */
export function spacesDir(): string {
  const dir = dataDir();
  return dir === ":memory:" ? ":memory:" : join(dir, "spaces");
}

/**
 * Resolve the appserver signing-key file. `DATA_DIR=:memory:` ⇒ null: the
 * sentinel means "no filesystem", so the key is ephemeral, not written under a
 * literal `:memory:` directory.
 */
export function signingKeyPath(): string | null {
  const dir = dataDir();
  return dir === ":memory:" ? null : join(dir, "appserver-signing-key.hex");
}
