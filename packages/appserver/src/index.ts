/**
 * Appserver boot entry point.
 *
 * Constructs the server via `createAppserver` (see `./appserver.ts`) with
 * env-derived options, then re-materializes all streams from the local
 * events DB. The factory handles all server construction — DBs, routes,
 * CORS, health endpoints, WebSocket — so this file is only the process
 * entry point and the re-materialization driver.
 */

import { createAppserver, type AppserverHandle } from "./appserver.ts";
import { log } from "./log.ts";
import { reMaterializeFromLocalEvents } from "./streams/reMaterialize.ts";
import { openDb } from "./db/db.ts";

// ─── Server construction ───────────────────────────────────────────────────

const app: AppserverHandle = await createAppserver();

// ─── Re-materialize from local events DB ─────────────────────────────────
// After the server is listening, replay all events from the local events DB
// to rebuild the materialized views. This runs on every boot — it's fast
// when the materialized DB is already current (the events are already
// applied, so applyBatch is a no-op for most events), and it catches up
// after a schema version wipe or Leaf migration.
//
// Re-materialization is intentionally fire-and-forget: the server is already
// accepting requests, and materialized data is available immediately for
// streams that have already been processed. If the events DB is unreachable
// or empty, the server still serves requests (with whatever materialized
// state exists).
const db = openDb();
reMaterializeFromLocalEvents(db).catch((err) => {
  log.error("startup", `re-materialization failed: ${err instanceof Error ? err.message : String(err)}`);
});

log.info("startup", `appserver ready (DID: ${app.ownDid}, port: ${app.port})`);
