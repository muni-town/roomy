/**
 * XRPC: space.roomy.admin.push.getStats (query).
 *
 * Returns the push dispatcher's lifetime counters (dispatched, delivered,
 * gone, failed, digests fired), current queue depth, VAPID configuration
 * status, and feature flag state. This is the "is the pipeline even alive?"
 * diagnostic — if `deliveredOk` is 0 and `failed` is climbing, the push
 * service is rejecting; if `dispatched` is 0, no messages are being
 * evaluated for push; if VAPID isn't configured, delivery is a no-op.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { isPushConfigured, getVapidPublicKey } from "../push/webpush.ts";
import { pushDispatcherStats } from "../push/dispatcher.ts";
import { getAllFlagState } from "../queries/featureFlags.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface PushStatsResult {
  vapidConfigured: boolean;
  vapidPublicKey: string | null;
  dispatcherStarted: boolean;
  stats: {
    queueDepth: number;
    dispatched: number;
    deliveredOk: number;
    gone: number;
    failed: number;
    digestsFired: number;
  };
  /** Total subscription rows across all users. */
  totalSubscriptions: number;
  /** Feature flag state for push-notifications. */
  pushFlag: {
    globalEnabled: boolean;
    assignedDids: string[];
  } | null;
}

export const adminGetPushStatsHandler: QueryHandler<
  QueryParams,
  PushStatsResult
> = async (_params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const db = openDb();
  const stats = pushDispatcherStats();

  // Count total subscriptions across all users.
  const countRow = await db.query(
    "select count(*) as n from readstate.push_subscriptions",
  ).get<{ n: number }>();
  const totalSubscriptions = countRow?.n ?? 0;

  // Feature flag state for push-notifications.
  const allFlags = await getAllFlagState(db);
  const pushFlag = allFlags.find((f) => f.key === "push-notifications") ?? null;

  return {
    vapidConfigured: isPushConfigured(),
    vapidPublicKey: getVapidPublicKey(),
    dispatcherStarted: stats.dispatched > 0 || stats.deliveredOk > 0 || stats.gone > 0 || stats.failed > 0 || stats.digestsFired > 0,
    stats: {
      queueDepth: stats.queueDepth,
      dispatched: stats.dispatched,
      deliveredOk: stats.deliveredOk,
      gone: stats.gone,
      failed: stats.failed,
      digestsFired: stats.digestsFired,
    },
    totalSubscriptions,
    pushFlag: pushFlag
      ? { globalEnabled: pushFlag.globalEnabled, assignedDids: pushFlag.assignedDids }
      : null,
  };
};