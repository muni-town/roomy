/**
 * Appserver boot entry point.
 *
 * Constructs the server via `createAppserver` (see `./appserver.ts`) with
 * env-derived options, then re-materializes all streams from the local
 * events DB. The factory handles all server construction — DBs, routes,
 * CORS, health endpoints, WebSocket — so this file is only the process
 * entry point and the re-materialization driver.
 *
 * Fatal handlers and the boot counter are installed as the first statements,
 * ahead of the top-level `await`s below: a rejection from `createAppserver`
 * or the membership migration is exactly the boot-window crash that must be
 * recorded (see `./fatal.ts`).
 */

import { createAppserver, type AppserverHandle } from "./appserver.ts";
import { log } from "./log.ts";
import { installFatalHandlers, recordProcessStart } from "./fatal.ts";
import {
  reMaterializeFromLocalEvents,
  DEFAULT_REMATERIALIZE_CONCURRENCY,
} from "./streams/reMaterialize.ts";
import { openDb, poolStats } from "./db/db.ts";
import { runPendingReadStateMigrationsWithRetry } from "./db/userSpaceMembershipMigration.ts";
import { getHappyView } from "./happyview.ts";

// ─── Fatal-exit visibility ─────────────────────────────────────────────────
// Install before anything that can throw or reject: a boot failure must leave
// an error record behind, not just a raw Bun abort that never reaches Loki.
// `recordProcessStart` bumps `roomy_process_starts_total`, which makes a
// restart loop visible to a scrape (`increase(...[10m]) > 3`).
installFatalHandlers();
recordProcessStart();

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
//
// Profile hydration uses the HappyView-first fetcher (HappyView → Bluesky
// fallback, or Bluesky-only when HappyView is not configured).
const db = openDb();

// ─── Durable membership recovery (awaited) ────────────────────────────────
// Recover user-space membership intent from the event log into the read-state
// DB before serving reads. This is a resumable migration: on a fresh deploy it
// scans the full join/leave history (current + deprecated personal events) and
// writes the durable `user_space_membership` rows that getSpaces/hydration/
// activity-feed now read. It must complete before reads serve, otherwise
// getSpaces would return empty during the boot window. Idempotent — on
// subsequent boots the migration is already stamped complete and this is a
// no-op.
//
// We retry a few times (a transient DB hiccup shouldn't take the server down),
// then fail fast: serving with an empty `user_space_membership` would silently
// hide every user's spaces, which is worse than a restart. The migration is
// resumable, so the orchestrator's restart retries it from where it left off.
await runPendingReadStateMigrationsWithRetry(db);

const happyView = getHappyView();
const poolSize = (await poolStats())?.size;
const concurrency = poolSize ?? DEFAULT_REMATERIALIZE_CONCURRENCY;
reMaterializeFromLocalEvents(db, undefined, happyView, concurrency).catch((err) => {
  log.error("startup", `re-materialization failed: ${err instanceof Error ? err.message : String(err)}`);
});

log.info("startup", `appserver ready (DID: ${app.ownDid}, port: ${app.port})`);
