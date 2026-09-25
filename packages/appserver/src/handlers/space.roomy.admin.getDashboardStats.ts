/**
 * XRPC: space.roomy.admin.getDashboardStats (query).
 *
 * Returns aggregate counters + system health for the admin dashboard
 * overview. Per-space stats live in the paginated
 * `space.roomy.admin.listSpaces` query (sorted by member count).
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 *
 * Response shape:
 * {
 *   activity: {
 *     activeSpaces: number,       // distinct streams with events in last 1h
 *     totalEvents: number,        // all-time events processed
 *     eventsToday: number,        // events in last 24h (since UTC midnight)
 *     connectedUsers: number,     // current WebSocket connections
 *   },
 *   system: {
 *     uptime: number,             // seconds since appserver start
 *     appserverDid: string,
 *     dbSizeBytes: number,        // SQLite file size
 *     pushVapidConfigured: boolean,
 *     pushTotalSubscriptions: number,
 *   },
 * }
 */

import { openDb, openReadStateDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { getSyncManager } from "../sync/handler.ts";
import { isPushConfigured } from "../push/webpush.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export interface DashboardStatsResult {
  activity: {
    activeSpaces: number;
    totalEvents: number;
    eventsToday: number;
    connectedUsers: number;
  };
  system: {
    uptime: number;
    appserverDid: string;
    dbSizeBytes: number;
    pushVapidConfigured: boolean;
    pushTotalSubscriptions: number;
  };
}

export const adminGetDashboardStatsHandler: QueryHandler<
  QueryParams,
  DashboardStatsResult
> = async (_params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const db = openDb();
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const todayStart = todayMidnight.getTime();

  // ── Activity stats ──────────────────────────────────────────────────────
  //
  // The event log is the largest table in the process and grows without bound,
  // so nothing here may scan it. The admin dashboard refreshes every 30s and
  // the DB request timeout is 30s, so each of these three queries must stay
  // indexed / O(streams):
  //
  //   totalEvents  — `stream_state` has one row per stream, and `idx` is
  //                  assigned as max(idx)+1 and never deleted, so a stream
  //                  holds exactly `latest_event + 1` events. Summing that is
  //                  exact and O(streams).
  //   eventsToday  — a range on `created_at`, served by the covering index.
  //   activeSpaces — a distinct-stream count over the recent slice. Written
  //                  the obvious way (`count(DISTINCT stream_id)`) SQLite
  //                  answers it by walking the whole `(stream_id, idx)`
  //                  primary key, because that ordering lets it short-circuit
  //                  DISTINCT — the `created_at` index is never consulted, so
  //                  the query stays O(rows) (measured: 7.0s at 4M rows).
  //                  Naming the index forces the recent slice first; the
  //                  DISTINCT then runs over ~500 rows instead of millions.
  const totalsRow = await db
    .query("SELECT coalesce(sum(latest_event + 1), 0) AS n FROM stream_state")
    .get<{ n: number }>();
  const totalEvents = totalsRow?.n ?? 0;

  const todayRow = await db
    .query(
      "SELECT count(*) AS n FROM stream_events WHERE created_at >= ?",
    )
    .get<{ n: number }>(todayStart);
  const eventsToday = todayRow?.n ?? 0;

  const activeRow = await db
    .query(
      `SELECT count(*) AS n FROM (
         SELECT DISTINCT stream_id
           FROM stream_events INDEXED BY idx_stream_events_created_at
          WHERE created_at >= ?
       )`,
    )
    .get<{ n: number }>(oneHourAgo);
  const activeSpaces = activeRow?.n ?? 0;

  let connectedUsers = 0;
  try {
    const sync = getSyncManager();
    if (sync) connectedUsers = sync.connectionCount;
  } catch {
    // SyncManager not initialized yet.
  }

  // ── System stats ────────────────────────────────────────────────────────

  const appserverDid = process.env.APPSERVER_DID ?? "did:web:api.roomy.space";

  const dbPath = process.env.APPSERVER_DB_PATH ?? "data/roomy.sqlite";
  let dbSizeBytes = 0;
  try {
    const stat = await Bun.file(dbPath).stat();
    dbSizeBytes = stat.size;
  } catch {
    // File not found or not accessible.
  }

  // Push stats. push_subscriptions lives in the read-state DB, not the
  // event-log DB (openDb), so it is counted via a read-state handle.
  const readStateDb = openReadStateDb();
  const totalSubRow = await readStateDb
    .query("SELECT count(*) AS n FROM push_subscriptions")
    .get<{ n: number }>();
  const pushTotalSubscriptions = totalSubRow?.n ?? 0;

  return {
    activity: {
      activeSpaces,
      totalEvents,
      eventsToday,
      connectedUsers,
    },
    system: {
      uptime: process.uptime(),
      appserverDid,
      dbSizeBytes,
      pushVapidConfigured: isPushConfigured(),
      pushTotalSubscriptions,
    },
  };
};