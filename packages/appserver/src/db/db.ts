/**
 * SQLite handle for the appserver's materialised view.
 *
 * One process-wide database, opened lazily. The schema in `./schema.sql`
 * mirrors the frontend worker schema so the SDK's pure materializer functions
 * can be reused unchanged.
 *
 * Materialisation is fully deterministic from the Leaf event log, so on a
 * schema-version mismatch the file is automatically deleted and re-created.
 *
 * The actual SQLite operations run in a Bun.Worker thread. This module
 * provides an AsyncDatabase proxy that communicates with the worker via
 * message-passing.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncDatabase } from "./asyncDatabase.ts";
import { READSTATE_SCHEMA_VERSION } from "./readStateDb.ts";

/**
 * Bump whenever schema.sql OR materialiser logic changes — a bump triggers
 * a wipe + full re-materialisation from the Leaf log, which is how a
 * materialiser change is rolled out to existing data. Mirrors the frontend's
 * `CONFIG.databaseSchemaVersion`. Strings, not numbers, so we can use
 * suffixes (e.g. `"6-appserver.1"`) once the two diverge.
 *
 * `.7`: getSpaces/hydration now read membership from `joinedSpace` edges
 * instead of `comp_space.hidden`; needs a re-materialise to seed the edges.
 *
 * `.10`: fixed missing ORDER BY in module "events" and "metadata" subscription
 * queries — without it, backfill pagination skips events. The old DB has
 * holes; a wipe forces clean re-materialisation with the fixed module.
 *
 * `.11`: added `comp_embed_link_data` table for caching enriched embed
 * metadata from the external embed service.
 *
 * `.10-appserver.3`: embed retry-with-backoff. `comp_embed_link_data`
 * gains `attempts` (consecutive transient-failure count) and `retry_after`
 * (epoch ms; transient failures re-queue after this backoff). The pending
 * query now also returns retry-eligible rows, so links stuck on a null row
 * from a transient failure (service down / timeout / 5xx) get re-tried
 * with exponential backoff instead of being permanently abandoned.
 * Definitive failures (404 / no-data) settle with no retry. Wipe re-derives
 * embed data from scratch.
 *
 * `.10-appserver.2`: SDK `createRoomLink` materialiser made idempotent
 * (`on conflict do nothing`) — re-applying the same link event no longer
 * flips `canonical_parent` 1 → 0, which corrupted parent-channel links for
 * threads on streams that got re-backfilled. Wipe re-derives correct
 * canonical_parent values from the event log.
 *
 * `.10-appserver.5`: added `banner`, `pronouns`, `website` columns to
 * `comp_info` for the Roomy profile record (`space.roomy.user.profile`).
 * Wipe re-materialises profiles from the new Roomy-first fetcher (PDS
 * record with Bluesky fallback), populating the new columns.
 *
 * `.10-appserver.6`: fix display name regression — the Bluesky fallback
 * path was overwriting `comp_info.name` with the handle when
 * `displayName` was absent, clobbering names set by `SetUserProfile`
 * events (bridged users) and prior fetches. Wipe re-materialises with
 * the fixed insert strategy (Bluesky fallback uses `on conflict do
 * nothing`, never writes handle as name).
 */
export const SCHEMA_VERSION = "10-appserver.6";

const DEFAULT_DB_PATH = process.env.APPSERVER_DB_PATH ?? "data/roomy.sqlite";

let dbInstance: AsyncDatabase | null = null;

export interface OpenDbOptions {
  /** Filesystem path or `:memory:`. Defaults to `APPSERVER_DB_PATH` or `data/roomy.sqlite`. */
  path?: string;
  /** If true, skip the process-wide singleton (useful for tests). */
  isolated?: boolean;
}

/**
 * Open (or return) the appserver's SQLite database, backed by a Bun.Worker.
 *
 * The worker opens both the materialisation DB and the read-state DB,
 * applies schemas, and ATTACHes the read-state DB as `readstate`.
 */
export function openDb(opts: OpenDbOptions = {}): AsyncDatabase {
  if (!opts.isolated && dbInstance) return dbInstance;

  const path = opts.path ?? DEFAULT_DB_PATH;
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");

  const db = new AsyncDatabase(workerPath);

  // Init is fire-and-forget; the returned proxy queues requests until init
  // completes. The caller should await the result if they need to know when
  // the DB is ready.
  db.init({
    mainDbPath: path,
    readStateDbPath: process.env.READSTATE_DB_PATH ?? "data/roomy-readstate.sqlite",
    eventsDbPath: process.env.EVENTS_DB_PATH ?? "data/roomy-events.sqlite",
    schemaVersion: SCHEMA_VERSION,
    readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
  });

  if (!opts.isolated) dbInstance = db;
  return db;
}

/** Return the singleton AsyncDatabase, or throw if not yet opened. */
export function getDb(): AsyncDatabase {
  if (!dbInstance) throw new Error("Database not opened. Call openDb() first.");
  return dbInstance;
}

/**
 * Close the process-wide database singleton. Used by tests to reset state.
 * Terminates the worker immediately so in-flight requests fail fast.
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.terminate();
    dbInstance = null;
  }
}
