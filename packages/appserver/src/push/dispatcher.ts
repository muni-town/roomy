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
 * Phase 2: the loop now serves two push kinds:
 *  - **Busy** immediate `message` pushes, emitted by `evaluatePush` and
 *    delivered in `processBatch`.
 *  - **Engaged digest** pushes — the on-event 5-message threshold is emitted by
 *    `evaluatePush` (a `digest` delivery) and delivered in `processBatch`; the
 *    1-hour time threshold is caught by the periodic {@link runDigestSweep},
 *    which runs on every idle wake alongside the 60s poll.
 */

import type { DbLike } from "../db/types.ts";
import { createHash } from "node:crypto";
import { log } from "../log.ts";
import { evaluatePush } from "./evaluate.ts";
import { sendPush } from "./webpush.ts";
import {
  pruneSubscriptionByEndpoint,
  selectSubscriptions,
} from "../queries/pushSubscriptions.ts";
import {
  markNotified,
  selectDueDigests,
} from "../queries/notificationState.ts";
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
  /** Process-wide materialisation DB (readstate is attached as `readstate.*`). */
  db: DbLike;
}

/** Start the global push dispatcher. Idempotent. Called once at startup. */
export function startPushDispatcher(opts: PushDispatcherOpts): void {
  if (started) return;
  dispatcherDb = opts.db;
  started = true;
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

  while (true) {
    try {
      const batch = queue.splice(0, queue.length);
      if (batch.length > 0) {
        await processBatch(db, batch);
        continue; // keep draining if more arrived
      }
      // Idle: run the Engaged digest sweep (catches 1h-elapsed batches even
      // with no new pokes), then wait for a poke or the periodic poll.
      await runDigestSweep(db);
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
      deliveries.push(...(await evaluatePush(db, job)));
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
 * or any author; we resolve the owning space from the room entity
 * (`entities.stream_id`) and the most-recent sender via {@link resolveLatestRoomAuthor}
 * so the payload can carry `spaceId` + an avatar icon.
 */
async function runDigestSweep(db: DbLike): Promise<void> {
  const due = await selectDueDigests(db, Date.now(), SWEEP_BATCH_LIMIT);
  if (due.length === 0) return;

  // Resolve room name + owning space (entities.stream_id) once for the batch
  // (cheap lookups), so each payload carries roomName + spaceId.
  const roomMeta = new Map<
    string,
    { name: string | null; spaceId: string | null }
  >();
  for (const row of due) {
    if (roomMeta.has(row.roomId)) continue;
    const r = await db.query(
      `select ci.name as name, e.stream_id as space_id
         from entities e
         left join comp_info ci on ci.entity = e.id
        where e.id = ?`,
    ).get<{ name: string | null; space_id: string | null }>(row.roomId);
    roomMeta.set(row.roomId, {
      name: r?.name ?? null,
      spaceId: r?.space_id ?? null,
    });
  }

  await mapWithConcurrency(due, CONCURRENCY, async (row) => {
    const meta = roomMeta.get(row.roomId);
    const spaceId = meta?.spaceId ?? "";
    const payload: PushPayload = {
      type: "digest",
      spaceId,
      roomId: row.roomId,
      count: row.unseenCount,
      ...(meta?.name != null ? { roomName: meta.name } : {}),
    };
    // Icon: most-recent sender avatar → space avatar (same "user avatars, or
    // failing that, space avatars" rule as message pushes). Sender avatars are
    // the reliable source; space `atblob://` avatars often 404.
    const latestAuthor = await resolveLatestRoomAuthor(db, row.roomId);
    const icon =
      (latestAuthor ? await resolveEntityAvatar(db, latestAuthor) : undefined) ??
      (await resolveEntityAvatar(db, spaceId));
    if (icon) payload.icon = icon;
    // Mark notified regardless of delivery success so a transient push-service
    // outage doesn't re-fire the same batch every 60s (Phase 4 adds retry).
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

/** Reset the dispatcher singleton (does not cancel a running loop). Tests only. */
export function _resetPushDispatcher(): void {
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
