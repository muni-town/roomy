/**
 * Push subscription store, backed by the read-state DB (`*`).
 *
 * A user may have many subscriptions (one per browser/device). Registrations
 * are idempotent on endpoint: re-registering the same endpoint updates the
 * row's kind/keys/expiry rather than duplicating, and clears its delivery
 * retry state — a fresh registration is a fresh claim that the device is
 * reachable.
 *
 * `kind` names the transport that can reach the row (`push/transport.ts`).
 * Web Push rows carry the push-service URL plus the RFC 8291 `p256dh`/`auth`
 * keys; a native transport's row carries its device token in `endpoint` and
 * leaves the keys empty.
 *
 * The retry columns (`attempts`, `retry_after`, `last_error`, `retry_payload`)
 * are written by the dispatcher when a transport reports a transient failure.
 * They live on the row rather than in the dispatcher's in-memory queue so a
 * pending re-attempt survives a restart: `retry_payload` is the body to send
 * again, and any dispatcher taking the lease picks the row up when its backoff
 * elapses.
 */

import type { DbLike } from "../db/types.ts";

export interface PushSubscriptionRow {
  userDid: string;
  endpoint: string;
  kind: string;
  p256dh: string;
  auth: string;
  expirationTime: number | null;
  /** Consecutive transient delivery failures; 0 while settled. */
  attempts: number;
  /** Epoch ms the pending re-attempt's backoff expires; null when none is pending. */
  retryAfter: number | null;
  /** Why the last delivery attempt failed; null after one that landed. */
  lastError: string | null;
  /** The body to send again; null when no re-attempt is pending. */
  retryPayload: string | null;
}

/** Upsert a subscription for `(userDid, endpoint)`. Idempotent on endpoint. */
export async function upsertSubscription(
  db: DbLike,
  sub: {
    userDid: string;
    endpoint: string;
    /** Transport that reaches this destination. Defaults to `webpush`. */
    kind?: string;
    p256dh?: string;
    auth?: string;
    expirationTime: number | null;
  },
): Promise<void> {
  await db.run(
    `insert into push_subscriptions
       (user_did, endpoint, kind, p256dh, auth, expiration_time, updated_at)
     values (?, ?, ?, ?, ?, ?, (unixepoch() * 1000))
     on conflict(user_did, endpoint) do update set
       kind = excluded.kind,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       expiration_time = excluded.expiration_time,
       attempts = 0,
       retry_after = null,
       last_error = null,
       retry_payload = null,
       updated_at = excluded.updated_at`,
    sub.userDid,
    sub.endpoint,
    sub.kind ?? "webpush",
    sub.p256dh ?? "",
    sub.auth ?? "",
    sub.expirationTime,
  );
}

/**
 * Keep a user's `keep` most recently updated `sse` rows and delete the rest.
 */
export async function evictOldestSseSubscriptions(
  db: DbLike,
  userDid: string,
  keep: number,
): Promise<void> {
  await db.run(
    `delete from push_subscriptions
       where user_did = ? and kind = 'sse'
         and endpoint not in (
           select endpoint from push_subscriptions
            where user_did = ? and kind = 'sse'
            order by updated_at desc, endpoint
            limit ?)`,
    userDid,
    userDid,
    keep,
  );
}

/** Remove a subscription by endpoint. Idempotent (no row = no-op). */
export async function deleteSubscription(
  db: DbLike,
  userDid: string,
  endpoint: string,
): Promise<void> {
  await db.run(
    "delete from push_subscriptions where user_did = ? and endpoint = ?",
    userDid,
    endpoint,
  );
}

/** The columns every read below returns, in the shape they are mapped from. */
const SUBSCRIPTION_COLUMNS = `user_did, endpoint, kind, p256dh, auth, expiration_time,
            attempts, retry_after, last_error, retry_payload`;

interface SubscriptionRecord {
  user_did: string;
  endpoint: string;
  kind: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
  attempts: number;
  retry_after: number | null;
  last_error: string | null;
  retry_payload: string | null;
}

function toRow(r: SubscriptionRecord): PushSubscriptionRow {
  return {
    userDid: r.user_did,
    endpoint: r.endpoint,
    kind: r.kind,
    p256dh: r.p256dh,
    auth: r.auth,
    expirationTime: r.expiration_time,
    attempts: r.attempts,
    retryAfter: r.retry_after,
    lastError: r.last_error,
    retryPayload: r.retry_payload,
  };
}

/**
 * All subscriptions for a user (one row per browser/device).
 *
 * Carries the retry state but does not filter on it: a row parked in backoff
 * is still a device the user registered, and a new message is worth an attempt
 * on it. A delivery that lands clears the park; one that fails again re-parks
 * against the newer payload.
 */
export async function selectSubscriptions(
  db: DbLike,
  userDid: string,
): Promise<PushSubscriptionRow[]> {
  const rows = await db
    .query(`select ${SUBSCRIPTION_COLUMNS} from push_subscriptions where user_did = ?`)
    .all<SubscriptionRecord>(userDid);
  return rows.map(toRow);
}

/**
 * Every subscription whose backoff has elapsed, oldest expiry first, bounded
 * by `limit`. This is the dispatcher's re-attempt selection: the pending work
 * is rows, so the loop that holds the lease finds it from whichever process
 * runs it, restart or not.
 */
export async function selectDueSubscriptions(
  db: DbLike,
  now: number,
  limit: number,
): Promise<PushSubscriptionRow[]> {
  const rows = await db
    .query(
      `select ${SUBSCRIPTION_COLUMNS}
         from push_subscriptions
        where retry_after is not null and retry_after <= ?
        order by retry_after
        limit ?`,
    )
    .all<SubscriptionRecord>(now, limit);
  return rows.map(toRow);
}

/** How many subscriptions are parked in a delivery backoff. */
export async function countPendingPushRetries(db: DbLike): Promise<number> {
  const row = await db
    .query("select count(*) as n from push_subscriptions where retry_after is not null")
    .get<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Subscriptions parked in a delivery backoff, earliest expiry first, bounded
 * by `limit`. Unlike {@link selectDueSubscriptions} this is not filtered by
 * time: a diagnostic wants every parked row, including the ones not yet due.
 */
export async function selectParkedSubscriptions(
  db: DbLike,
  limit: number,
): Promise<PushSubscriptionRow[]> {
  const rows = await db
    .query(
      `select ${SUBSCRIPTION_COLUMNS}
         from push_subscriptions
        where retry_after is not null
        order by retry_after
        limit ?`,
    )
    .all<SubscriptionRecord>(limit);
  return rows.map(toRow);
}

/**
 * The earliest pending backoff expiry, or null when nothing is parked. The
 * dispatcher's idle wait is clamped by it, so a parked row is re-attempted
 * when its backoff elapses instead of on the next minute's poll.
 */
export async function selectEarliestRetryAt(db: DbLike): Promise<number | null> {
  const row = await db
    .query(
      "select min(retry_after) as at from push_subscriptions where retry_after is not null",
    )
    .get<{ at: number | null }>();
  return row?.at ?? null;
}

/**
 * Record a transient failure: bump `attempts`, park the row until `retryAfter`
 * with the body to send again, and keep the reason. Returns the new
 * consecutive-failure count, or null when the row is gone — a concurrent
 * delivery can prune every row sharing an endpoint (`pruneSubscriptionByEndpoint`
 * is cross-user), and a failure recorded against a row that no longer exists
 * must not decide anything.
 *
 * The increment happens in SQL so the count stays correct if two deliveries
 * for the same endpoint overlap. `retryAfter` is computed by the caller from
 * the attempt count it *read*, so under that same race the park can be one
 * step short of the schedule. The next failure re-parks from the true count,
 * and the ceiling is decided from the value returned here, so a short park
 * costs one early attempt and never an early prune.
 */
export async function recordDeliveryFailure(
  db: DbLike,
  sub: { userDid: string; endpoint: string },
  retryAfter: number,
  error: string,
  payload: string,
): Promise<number | null> {
  const row = await db
    .query(
      `update push_subscriptions
          set attempts = attempts + 1,
              retry_after = ?,
              last_error = ?,
              retry_payload = ?,
              updated_at = (unixepoch() * 1000)
        where user_did = ? and endpoint = ?
        returning attempts`,
    )
    .get<{ attempts: number }>(retryAfter, error, payload, sub.userDid, sub.endpoint);
  return row?.attempts ?? null;
}

/**
 * Settle the row: no failure outstanding and no re-attempt pending. Called
 * after a delivery lands, and after a terminal failure that a re-attempt
 * cannot fix.
 */
export async function clearDeliveryFailure(
  db: DbLike,
  sub: { userDid: string; endpoint: string },
): Promise<void> {
  await db.run(
    `update push_subscriptions
        set attempts = 0,
            retry_after = null,
            last_error = null,
            retry_payload = null
      where user_did = ? and endpoint = ?`,
    sub.userDid,
    sub.endpoint,
  );
}

/**
 * Drop a single subscription row by endpoint (used when the push service
 * returns 404/410 — the browser unsubscribed/expired — and when a row passes
 * its failure ceiling). Cross-user safe: deletes every row sharing that
 * endpoint (an endpoint uniquely identifies a subscription regardless of
 * which user row it's under).
 */
export async function pruneSubscriptionByEndpoint(
  db: DbLike,
  endpoint: string,
): Promise<void> {
  await db.run(
    "delete from push_subscriptions where endpoint = ?",
    endpoint,
  );
}
