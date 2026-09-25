/**
 * PushDispatcher — single process-wide background loop that owns all push
 * delivery, modelled on `embed/sweeper.ts`.
 *
 * The `StreamManager` *pokes* this loop with live `createMessage` jobs (see
 * `pokePushDispatcher`); it never drives delivery inline. All DB lookups
 * (recipient enumeration, preference resolution, access checks) and all
 * network I/O (calls to Mozilla/FCM/Apple push services) happen here, in the
 * background, so push never blocks the live sendEvents/materialise path.
 *
 * Outbound push-service calls are network-bound and can be slow, so they run
 * with bounded concurrency and a self-healing backoff on 429/5xx. Subscriptions
 * that return 404/410 (the browser unsubscribed / expired) are pruned.
 *
 * The loop serves two push kinds:
 *  - **Busy** immediate `message` pushes, emitted by `evaluatePush` and
 *    delivered in `processBatch`.
 *  - **Engaged digest** pushes — the on-event 5-message threshold is emitted by
 *    `evaluatePush` (a `digest` delivery) and delivered in `processBatch`; the
 *    1-hour time threshold is caught by the periodic {@link runDigestSweep},
 *    which runs on every idle wake alongside the 60s poll.
 */

import type { DbLike } from "../db/types.ts";
import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { createHash } from "node:crypto";
import { log } from "../log.ts";
import { evaluatePush, resolveAuthorName } from "./evaluate.ts";
import { sendPush } from "./webpush.ts";
import {
  pruneSubscriptionByEndpoint,
  selectSubscriptions,
} from "../queries/pushSubscriptions.ts";
import {
  markNotified,
  resetNotificationState,
  selectDueDigests,
} from "../queries/notificationState.ts";
import { PUSH_MAX_DIGEST_AGE_MS } from "./freshness.ts";
import { resolveEntityAvatar, resolveLatestRoomAuthor } from "./avatars.ts";
import type { PushDelivery, PushJob, PushPayload } from "./types.ts";

/**
 * Build a Web Push `Topic` header value for a room. The spec requires ≤32
 * base64url chars (`[A-Za-z0-9_-]`); a literal `room:<roomId>` contains `:`/`/`
 * (Roomy room ids are lexicon URIs) which the push service rejects. Derive a
 * deterministic 32-char base64url token from a sha256 of the roomId so a
 * room's notifications still coalesce across deliveries.
 */
function roomTopic(roomId: string): string {
  return createHash("sha256").update(roomId).digest().toString("base64url").slice(0, 32);
}

/** How often to wake the loop while idle (no pokes). */
const IDLE_POLL_MS = 60_000;

/** Max concurrent outbound push-service calls. */
const CONCURRENCY = Number(process.env.PUSH_CONCURRENCY ?? 8);

/** Max due digests to fire per sweep cycle (gradual drain, no push-service flood). */
const SWEEP_BATCH_LIMIT = 64;

let dispatcherDb: DbLike | undefined;
let started = false;
/** Set when the loop should exit (test teardown); checked between cycles. */
let stopped = false;

/** Lifetime counters, exposed via {@link pushDispatcherStats}. */
let statsDispatched = 0;
let statsDeliveredOk = 0;
let statsGone = 0;
let statsFailed = 0;
let statsDigestsFired = 0;

/** Pending live createMessage jobs, drained FIFO. */
const queue: PushJob[] = [];

/** Resolved by {@link pokePushDispatcher} to wake an idle loop. */
let wake: (() => void) | null = null;
export interface PushDispatcherOpts {
  /** Read-state DB handle (read_positions, notification_state, push_subscriptions, …). */
  db: DbLike;
}

/** Start the global push dispatcher. Idempotent. Called once at startup. */
export function startPushDispatcher(opts: PushDispatcherOpts): void {
  if (started) return;
  dispatcherDb = opts.db;
  started = true;
  stopped = false;
  void runDispatcherLoop().catch((err) => {
    log.error("[push-dispatcher] loop crashed:", err);
  });
}


export function pushDispatcherStats(): {
  queueDepth: number;
  dispatched: number;
  deliveredOk: number;
  gone: number;
  failed: number;
  digestsFired: number;
} {
  return {
    queueDepth: queue.length,
    dispatched: statsDispatched,
    deliveredOk: statsDeliveredOk,
    gone: statsGone,
    failed: statsFailed,
    digestsFired: statsDigestsFired,
  };
}

/**
 * Enqueue live createMessage jobs and wake an idle loop. Cheap and safe to
 * call frequently: if the loop is busy draining, extra pokes just append to
 * the queue. Called by the `StreamManager` on every live createMessage batch
 * (skipped for backfill, matching the unread-counter/embed-sweeper gate).
 */
export function pokePushDispatcher(jobs: PushJob[]): void {
  if (jobs.length === 0) return;
  if (!started) return; // dispatcher not running
  for (const j of jobs) queue.push(j);
  const fn = wake;
  if (fn) fn();
}

async function runDispatcherLoop(): Promise<void> {
  const db = dispatcherDb;
  if (!db) return;

  while (!stopped) {
    try {
      const batch = queue.splice(0, queue.length);
      if (batch.length > 0) {
        await processBatch(db, batch);
        continue; // keep draining if more arrived
      }
      // Idle: run the Engaged digest sweep (catches 1h-elapsed batches even
      // with no new pokes), then wait for a poke or the periodic poll.
      await _runDigestSweep(db);
      await waitForWake(IDLE_POLL_MS);
    } catch (err) {
      // Outer resilience: an unexpected throw must not permanently kill the
      // process-wide loop. Log, pause, continue.
      log.error("[push-dispatcher] cycle threw (continuing):", err);
      await waitForWake(IDLE_POLL_MS);
    }
  }
}

/**
 * Evaluate a batch of jobs and deliver the resulting pushes with bounded
 * concurrency. Per-job failures are isolated: one bad push-service call never
 * kills the batch or the loop.
 */
async function processBatch(db: DbLike, batch: PushJob[]): Promise<void> {
  // Evaluate all jobs first (pure DB work), flattening to deliveries.
  const deliveries: PushDelivery[] = [];
  for (const job of batch) {
    statsDispatched++;
    try {
      // Route per-space reads to the job's owning per-space DB; read-state
      // reads stay on the read-state handle (`db`).
      const spaceDb = openSpaceDb(job.spaceId);
      deliveries.push(...(await evaluatePush(db, spaceDb, job)));
    } catch (err) {
      log.error(`[push-dispatcher] evaluatePush failed for ${job.messageId}:`, err);
    }
  }

  if (deliveries.length === 0) return;

  // Deliver each recipient's payload to all their subscription endpoints.
  await mapWithConcurrency(deliveries, CONCURRENCY, (delivery) =>
    deliverPayload(db, delivery.userDid, delivery.payload),
  );
}

/**
 * Fire time-based Engaged digests: select `notification_state` rows whose 1h
 * timer elapsed (and haven't fired), deliver a digest push to each, and mark
 * them notified. Bounded by {@link SWEEP_BATCH_LIMIT} per cycle so a large
 * backlog drains gradually. Runs on every idle wake.
 *
 * The sweep row carries `(userDid, roomId, unseenCount)` but not the spaceId
 * or any author; we resolve the owning space from the global `entity_space`
 * index and the most-recent sender via {@link resolveLatestRoomAuthor}
 * (both against the room's per-space DB) so the payload can carry `spaceId`
 * + an author name (via {@link resolveAuthorName}) + an avatar icon.
 */
export async function _runDigestSweep(db: DbLike): Promise<void> {
  const due = await selectDueDigests(db, Date.now(), SWEEP_BATCH_LIMIT);
  if (due.length === 0) return;

  // Freshness gate. A digest row whose batch *began* long ago is not a "you
  // missed this" prompt — it is stale state that accumulated while nothing
  // fired (the process was down, the room was never reopened, a replay seeded
  // it). Firing it greets the user with hours-old messages, and every restart
  // re-fires it. Drop the stale rows instead: they can never become current,
  // and the user's unread counter is driven by `read_positions`, not by this
  // table, so nothing user-visible is lost.
  const now = Date.now();
  // `first_unseen_at` is null-typed at the SQL boundary (the column is
  // nullable), though the query filters those rows out. Treat an absent
  // timestamp as stale: a digest row with no batch start has no batch to
  // report.
  const isStale = (row: { firstUnseenAt: number | null }): boolean =>
    row.firstUnseenAt == null || now - row.firstUnseenAt > PUSH_MAX_DIGEST_AGE_MS;
  const stale = due.filter(isStale);
  const fresh = due.filter((row) => !isStale(row));
  for (const row of stale) {
    await resetNotificationState(db, row.userDid, row.roomId);
  }
  if (stale.length > 0) {
    log.info(
      `[push-freshness] dropped ${stale.length}/${due.length} stale digest batch(es) (first unseen older than ${PUSH_MAX_DIGEST_AGE_MS}ms)`,
    );
  }
  if (fresh.length === 0) return;

  // The sweep row carries `(userDid, roomId, unseenCount)` but not the
  // spaceId. Resolve each room's owning space via the global `entity_space`
  // index, then open the per-space DB for room metadata + latest-author
  // lookups. Read-state reads (due digests, markNotified, deliverPayload)
  // stay on the read-state handle (`db`).
  const global = openGlobalDb();
  const roomMeta = new Map<
    string,
    {
      name: string | null;
      spaceId: string | null;
      authorDid: string | null;
      authorName: string | null;
    }
  >();
  const iconByRoom = new Map<string, string>();
  for (const row of fresh) {
    if (roomMeta.has(row.roomId)) continue;
    const spaceRow = await global
      .query("select space_did from entity_space where entity_id = ?")
      .get<{ space_did: string }>(row.roomId);
    const spaceId = spaceRow?.space_did ?? null;
    roomMeta.set(row.roomId, { name: null, spaceId, authorDid: null, authorName: null });
    if (spaceId) {
      const spaceDb = openSpaceDb(spaceId);
      const r = await spaceDb.query(
        `select ci.name as name
           from entities e
           left join comp_info ci on ci.entity = e.id
          where e.id = ?`,
      ).get<{ name: string | null }>(row.roomId);
      // Most-recent sender: one author per room batch — name + avatar. The
      // name degrades through the global `profiles` store to the raw DID
      // (never null once a DID is known), so a digest names its sender too.
      const latestAuthor = await resolveLatestRoomAuthor(spaceDb, row.roomId);
      const authorName = latestAuthor
        ? await resolveAuthorName(spaceDb, latestAuthor)
        : null;
      roomMeta.set(row.roomId, {
        name: r?.name ?? null,
        spaceId,
        authorDid: latestAuthor,
        authorName,
      });
      // Icon: most-recent sender avatar → space avatar (same "user avatars, or
      // failing that, space avatars" rule as message pushes). Sender avatars
      // are the reliable source; space `atblob://` avatars often 404.
      const icon =
        (latestAuthor ? await resolveEntityAvatar(spaceDb, latestAuthor) : undefined) ??
        (await resolveEntityAvatar(spaceDb, spaceId));
      if (icon) iconByRoom.set(row.roomId, icon);
    }
  }

  await mapWithConcurrency(fresh, CONCURRENCY, async (row) => {
    const meta = roomMeta.get(row.roomId);
    const spaceId = meta?.spaceId ?? "";
    const payload: PushPayload = {
      type: "digest",
      spaceId,
      roomId: row.roomId,
      count: row.unseenCount,
      ...(meta?.name != null ? { roomName: meta.name } : {}),
      ...(meta?.authorDid != null
        ? { authorDid: meta.authorDid, authorName: meta.authorName ?? meta.authorDid }
        : {}),
    };
    const icon = iconByRoom.get(row.roomId);
    if (icon) payload.icon = icon;
    // Mark notified regardless of delivery success so a transient push-service
    // outage doesn't re-fire the same batch every 60s (no retry).
    await deliverPayload(db, row.userDid, payload);
    await markNotified(db, row.userDid, row.roomId);
    statsDigestsFired++;
  });
}

/**
 * Deliver one payload to all of a user's subscription endpoints, with
 * per-room `topic` coalescing. Shared by the on-event path (`processBatch`)
 * and the time-based sweep. Failures are logged, never thrown to the caller.
 */
async function deliverPayload(
  db: DbLike,
  userDid: string,
  payload: PushPayload,
): Promise<void> {
  const subs = await selectSubscriptions(db, userDid);
  if (subs.length === 0) return;
  const body = JSON.stringify(payload);
  const topic = roomTopic(payload.roomId);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        const res = await sendPush(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
            expirationTime: sub.expirationTime,
          },
          body,
          { topic, urgency: "normal" },
        );
        if (res.gone) {
          // Browser unsubscribed / expired — prune so we never retry it.
          await pruneSubscriptionByEndpoint(db, sub.endpoint);
          statsGone++;
          let service = "unknown";
          try { service = new URL(sub.endpoint).hostname; } catch { /* leave */ }
          log.info(`[push-deliver] GONE (pruned) service=${service} endpoint=${sub.endpoint.slice(0, 60)}…`);
        } else if (res.status !== null) {
          statsDeliveredOk++;
          let service = "unknown";
          try { service = new URL(sub.endpoint).hostname; } catch { /* leave */ }
          log.debug(`[push-deliver] OK status=${res.status} service=${service} endpoint=${sub.endpoint.slice(0, 60)}…`);
        }
      } catch (err) {
        statsFailed++;
        // web-push throws WebPushError (has .statusCode) on 429/5xx; narrow
        // rather than assume the shape.
        let status = "?";
        if (
          typeof err === "object" &&
          err !== null &&
          "statusCode" in err &&
          typeof (err as { statusCode?: unknown }).statusCode === "number"
        ) {
          status = String((err as { statusCode: number }).statusCode);
        }
        let service = "unknown";
        try { service = new URL(sub.endpoint).hostname; } catch { /* leave */ }
        log.warn(
          `[push-deliver] FAILED status=${status} service=${service} endpoint=${sub.endpoint.slice(0, 60)}…:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]!);
      }
    },
  );
  await Promise.all(workers);
}

/** Resolve after `ms`, or immediately when {@link pokePushDispatcher} fires. */
function waitForWake(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    wake = null;
    resolve();
  }, ms);
  wake = () => {
    clearTimeout(timer);
    wake = null;
    resolve();
  };
  return promise;
}

/**
 * Reset the dispatcher singleton and stop the running loop. Tests only.
 * The loop checks `stopped` between cycles and exits, so it can't cycle
 * against a closed DB after teardown.
 */
export function _resetPushDispatcher(): void {
  stopped = true;
  dispatcherDb = undefined;
  started = false;
  queue.length = 0;
  wake = null;
  statsDispatched = 0;
  statsDeliveredOk = 0;
  statsGone = 0;
  statsFailed = 0;
  statsDigestsFired = 0;
}
