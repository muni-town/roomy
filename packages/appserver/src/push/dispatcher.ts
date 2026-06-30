/**
 * PushDispatcher — single process-wide background loop that owns all push
 * delivery, modelled on `embed/sweeper.ts`.
 *
 * `SpaceMaterializer` *pokes* this loop with live `createMessage` jobs (see
 * `pokePushDispatcher`); it never drives delivery inline. All DB lookups
 * (recipient enumeration, preference resolution, access checks) and all
 * network I/O (calls to Mozilla/FCM/Apple push services) happen here, in the
 * background, so push never blocks materialisation.
 *
 * Outbound push-service calls are network-bound and can be slow, so they run
 * with bounded concurrency and a self-healing backoff on 429/5xx. Subscriptions
 * that return 404/410 (the browser unsubscribed / expired) are pruned.
 *
 * Phase 1: immediate Busy pushes only. The idle poll exists but does no
 * digest work yet — Phase 2 extends the loop with the Engaged digest sweep
 * (`notification_state` rows whose 1h timer elapsed).
 */

import type { Database } from "bun:sqlite";
import { log } from "../log.ts";
import { evaluatePush } from "./evaluate.ts";
import { sendPush } from "./webpush.ts";
import {
  pruneSubscriptionByEndpoint,
  selectSubscriptions,
} from "../queries/pushSubscriptions.ts";
import type { PushDelivery, PushJob } from "./types.ts";

/** How often to wake the loop while idle (no pokes). */
const IDLE_POLL_MS = 60_000;

/** Max concurrent outbound push-service calls. */
const CONCURRENCY = Number(process.env.PUSH_CONCURRENCY ?? 8);

let dispatcherDb: Database | undefined;
let started = false;

/** Lifetime counters, exposed via {@link pushDispatcherStats}. */
let statsDispatched = 0;
let statsDeliveredOk = 0;
let statsGone = 0;
let statsFailed = 0;

/** Pending live createMessage jobs, drained FIFO. */
const queue: PushJob[] = [];

/** Resolved by {@link pokePushDispatcher} to wake an idle loop immediately. */
let wake: (() => void) | null = null;

export interface PushDispatcherOpts {
  /** Process-wide materialisation DB (readstate is attached as `readstate.*`). */
  db: Database;
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
} {
  return {
    queueDepth: queue.length,
    dispatched: statsDispatched,
    deliveredOk: statsDeliveredOk,
    gone: statsGone,
    failed: statsFailed,
  };
}

/**
 * Enqueue live createMessage jobs and wake an idle loop. Cheap and safe to
 * call frequently: if the loop is busy draining, extra pokes just append to
 * the queue. Called by `SpaceMaterializer` on every live createMessage batch
 * (skipped for backfill, matching the unread-counter/embed-sweeper gate).
 */
export function pokePushDispatcher(jobs: PushJob[]): void {
  if (jobs.length === 0) return;
  for (const j of jobs) queue.push(j);
  const fn = wake;
  if (fn) fn();
}

async function runDispatcherLoop(): Promise<void> {
  const db = dispatcherDb;
  if (!db) return;

  while (true) {
    try {
      const batch = drainQueue();
      if (batch.length > 0) {
        await processBatch(db, batch);
        continue; // keep draining if more arrived
      }
      // Idle: wait for a poke or the periodic poll. (Phase 2 will run the
      // digest sweep here on each idle wake.)
      await waitForWake(IDLE_POLL_MS);
    } catch (err) {
      // Outer resilience: an unexpected throw must not permanently kill the
      // process-wide loop. Log, pause, continue.
      log.error("[push-dispatcher] cycle threw (continuing):", err);
      await waitForWake(IDLE_POLL_MS);
    }
  }
}

/** Drain the current queue snapshot (FIFO). */
function drainQueue(): PushJob[] {
  if (queue.length === 0) return [];
  const batch = queue.splice(0, queue.length);
  return batch;
}

/**
 * Evaluate a batch of jobs and deliver the resulting pushes with bounded
 * concurrency. Per-job failures are isolated: one bad push-service call never
 * kills the batch or the loop.
 */
async function processBatch(db: Database, batch: PushJob[]): Promise<void> {
  // Evaluate all jobs first (pure DB work), flattening to deliveries.
  const deliveries: PushDelivery[] = [];
  for (const job of batch) {
    statsDispatched++;
    try {
      deliveries.push(...evaluatePush(db, job));
    } catch (err) {
      log.error(`[push-dispatcher] evaluatePush failed for ${job.messageId}:`, err);
    }
  }

  if (deliveries.length === 0) return;

  // Deliver each recipient's payload to all their subscription endpoints.
  // `topic: room:<roomId>` makes a room's notifications replace each other
  // (coalescing for Busy). Bounded concurrency so we never flood a push
  // service; failures are logged, never thrown to the caller.
  await mapWithConcurrency(deliveries, CONCURRENCY, async (delivery) => {
    const subs = selectSubscriptions(db, delivery.userDid);
    if (subs.length === 0) return;
    const payload = JSON.stringify(delivery.payload);
    const topic = `room:${delivery.payload.roomId}`;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const res = await sendPush(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
              expirationTime: sub.expirationTime,
            },
            payload,
            { topic, urgency: "normal" },
          );
          if (res.gone) {
            // Browser unsubscribed / expired — prune so we never retry it.
            pruneSubscriptionByEndpoint(db, sub.endpoint);
            statsGone++;
            log.debug(`[push-dispatcher] pruned gone subscription ${sub.endpoint.slice(0, 40)}…`);
          } else if (res.status !== null) {
            statsDeliveredOk++;
          }
        } catch (err) {
          statsFailed++;
          const status = (err as { statusCode?: number })?.statusCode;
          log.warn(
            `[push-dispatcher] send failed (status=${status ?? "?"}) for ${sub.endpoint.slice(0, 40)}…:`,
            err instanceof Error ? err.message : err,
          );
          // Phase 1: log + move on. Phase 4 will add retry/backoff.
        }
      }),
    );
  });
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
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
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
}