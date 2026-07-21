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

import { openDb } from "../db/db.ts";
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

  const totalRow = await db
    .query("SELECT count(*) AS n FROM events.stream_events")
    .get<{ n: number }>();
  const totalEvents = totalRow?.n ?? 0;

  const todayRow = await db
    .query(
      "SELECT count(*) AS n FROM events.stream_events WHERE created_at >= ?",
    )
    .get<{ n: number }>(todayStart);
  const eventsToday = todayRow?.n ?? 0;

  const activeRow = await db
    .query(
      "SELECT count(DISTINCT stream_id) AS n FROM events.stream_events WHERE created_at >= ?",
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

  // Push stats.
  const totalSubRow = await db
    .query("SELECT count(*) AS n FROM readstate.push_subscriptions")
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