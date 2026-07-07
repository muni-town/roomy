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
// Replay un-materialized events from the local events DB to bring the
// materialized views up to date. The `materialization_cursor` table tracks
// how far each stream has been materialized; streams that are already caught
// up are skipped entirely (no event reads, no materialization). A full
// replay only happens after a schema-version wipe (which empties the cursor
// table). On a normal restart the cursors are current, so this is cheap.
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
