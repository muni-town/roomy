/**
 * Push subscription store, backed by the read-state DB (`readstate.*`).
 *
 * A user may have many subscriptions (one per browser/device). Registrations
 * are idempotent on endpoint: re-registering the same endpoint updates its
 * keys/expiry rather than duplicating.
 */

import type { Database } from "bun:sqlite";

export interface PushSubscriptionRow {
  userDid: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: number | null;
}

/** Upsert a subscription for `(userDid, endpoint)`. Idempotent on endpoint. */
export function upsertSubscription(
  db: Database,
  sub: {
    userDid: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    expirationTime: number | null;
  },
): void {
  db.prepare(
    `insert into readstate.push_subscriptions
       (user_did, endpoint, p256dh, auth, expiration_time, updated_at)
     values (?, ?, ?, ?, ?, (unixepoch() * 1000))
     on conflict(user_did, endpoint) do update set
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       expiration_time = excluded.expiration_time,
       updated_at = excluded.updated_at`,
  ).run(sub.userDid, sub.endpoint, sub.p256dh, sub.auth, sub.expirationTime);
}

/** Remove a subscription by endpoint. Idempotent (no row = no-op). */
export function deleteSubscription(
  db: Database,
  userDid: string,
  endpoint: string,
): void {
  db.prepare(
    "delete from readstate.push_subscriptions where user_did = ? and endpoint = ?",
  ).run(userDid, endpoint);
}

/** All subscriptions for a user (one row per browser/device). */
export function selectSubscriptions(
  db: Database,
  userDid: string,
): PushSubscriptionRow[] {
  return db
    .query<
      {
        user_did: string;
        endpoint: string;
        p256dh: string;
        auth: string;
        expiration_time: number | null;
      },
      [string]
    >(
      "select user_did, endpoint, p256dh, auth, expiration_time from readstate.push_subscriptions where user_did = ?",
    )
    .all(userDid)
    .map((r) => ({
      userDid: r.user_did,
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      expirationTime: r.expiration_time,
    }));
}

/**
 * Drop a single subscription row by endpoint (used when the push service
 * returns 404/410 — the browser unsubscribed/expired). Cross-user safe:
 * deletes every row sharing that endpoint (an endpoint uniquely identifies a
 * subscription regardless of which user row it's under).
 */
export function pruneSubscriptionByEndpoint(
  db: Database,
  endpoint: string,
): void {
  db.prepare(
    "delete from readstate.push_subscriptions where endpoint = ?",
  ).run(endpoint);
}