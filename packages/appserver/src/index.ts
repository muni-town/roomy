/**
 * Appserver boot entry point.
 *
 * Constructs the server via `createAppserver` (see `./appserver.ts`) with
 * env-derived options, then starts Leaf backfill. The factory handles all
 * server construction — DBs, routes, CORS, health endpoints, WebSocket —
 * so this file is only the process entry point and the backfill driver.
 */

import { createAppserver, type AppserverHandle } from "./appserver.ts";
import { log } from "./log.ts";

// ─── Server construction ───────────────────────────────────────────────────

const app: AppserverHandle = await createAppserver();

log.info("startup", `appserver ready (DID: ${app.ownDid}, port: ${app.port})`);
