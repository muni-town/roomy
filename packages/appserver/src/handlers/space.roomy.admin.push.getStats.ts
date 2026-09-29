/**
 * Returns the push dispatcher's lifetime counters (dispatched, delivered,
 * skipped, gone, failed, digests fired), current queue depth, and VAPID
 * configuration status. This is the "is the pipeline even alive?" diagnostic —
 * if `deliveredOk` is 0 and `failed` is climbing, the push service is
 * rejecting; if `skipped` is climbing instead, transports are declining to
 * attempt delivery (VAPID unset, or a device no transport can reach) and
 * nothing is being sent; if `dispatched` is 0, no messages are being evaluated
 * for push.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openReadStateDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { isPushConfigured, getVapidPublicKey } from "../push/transports/webPush.ts";
import { pushDispatcherStats } from "../push/dispatcher.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface PushStatsResult {
  vapidConfigured: boolean;
  vapidPublicKey: string | null;
  dispatcherStarted: boolean;
  stats: {
    queueDepth: number;
    dispatched: number;
    deliveredOk: number;
    /** Deliveries no transport attempted (unconfigured, or unreachable device). */
    skipped: number;
    gone: number;
    failed: number;
    digestsFired: number;
  };
  /** Total subscription rows across all users. */
  totalSubscriptions: number;
}

export const adminGetPushStatsHandler: QueryHandler<
  QueryParams,
  PushStatsResult
> = async (_params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const db = openReadStateDb();
  const stats = pushDispatcherStats();

  // Count total subscriptions across all users.
  const countRow = await db.query(
    "select count(*) as n from push_subscriptions",
  ).get<{ n: number }>();
  const totalSubscriptions = countRow?.n ?? 0;

  return {
    vapidConfigured: isPushConfigured(),
    vapidPublicKey: getVapidPublicKey(),
    dispatcherStarted: stats.dispatched > 0 || stats.deliveredOk > 0 || stats.skipped > 0 || stats.gone > 0 || stats.failed > 0 || stats.digestsFired > 0,
    stats: {
      queueDepth: stats.queueDepth,
      dispatched: stats.dispatched,
      deliveredOk: stats.deliveredOk,
      skipped: stats.skipped,
      gone: stats.gone,
      failed: stats.failed,
      digestsFired: stats.digestsFired,
    },
    totalSubscriptions,
  };
};