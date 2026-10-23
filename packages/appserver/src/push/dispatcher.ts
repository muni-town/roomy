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
 * with bounded concurrency. A transport tells three kinds of failure apart
 * (`PushOutcome` in `transports/types.ts`): `gone` (the destination is dead —
 * pruned), `skipped` (nothing was attempted), and `retry` (429/5xx/a dropped
 * connection — worth another attempt). A `retry` is written to the
 * subscription row as a backoff and re-attempted by {@link _runPushRetrySweep}
 * at the top of every cycle; after {@link maxRetryAttempts} consecutive
 * transient failures the row is pruned like a `gone` one, so a device that
 * never answers does not fail forever.
 *
 * The loop serves two push kinds:
 *  - **Busy** immediate `message` pushes, emitted by `evaluatePush` and
 *    delivered in `processBatch`.
 *  - **Engaged digest** pushes — the on-event 5-message threshold is emitted by
 *    `evaluatePush` (a `digest` delivery) and delivered in `processBatch`; the
 *    1-hour time threshold is caught by the periodic {@link _runDigestSweep},
 *    which runs on every idle wake alongside the 60s poll.
 *
 * Each cycle also runs {@link _runPushRetrySweep} before either, so a parked
 * subscription is re-attempted whether or not new messages are arriving.
 */

import type { DbLike } from "../db/types.ts";
import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import { createHash } from "node:crypto";
import { log } from "../log.ts";
import { evaluatePush, resolveAuthorName } from "./evaluate.ts";
import { maxRetryAttempts, retryBackoffMs } from "./retry.ts";
// Transport registration: importing a transport module installs it in
// `PUSH_TRANSPORTS`. Every transport the appserver ships must be imported here
// (or by another module on the boot path), or a stored row naming it is counted
// as unregistered instead of reaching the transport.
import "./transports/webPush.ts";
import "./transports/apn.ts";
import "./transports/fcm.ts";
import "./transports/sse.ts";
import { PUSH_TRANSPORTS, type PushOutcome } from "./transports/types.ts";
import { WorkerLease } from "../workers/lease.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import {
  clearDeliveryFailure,
  pruneSubscriptionByEndpoint,
  recordDeliveryFailure,
  selectDueSubscriptions,
  selectEarliestRetryAt,
  selectSubscriptions,
  type PushSubscriptionRow,
} from "../queries/pushSubscriptions.ts";
import {
  markNotified,
  resetNotificationState,
  selectDueDigests,
} from "../queries/notificationState.ts";
import { PUSH_MAX_DIGEST_AGE_MS } from "./freshness.ts";
import { resolveEntityAvatar, resolveLatestRoomAuthor } from "./avatars.ts";
import { hiddenBy } from "../queries/userBlocks.ts";
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
/** Resolved when the background loop exits. Used by stopPushDispatcher. */
let loopPromise: Promise<void> | undefined;

/** The dispatcher's row in `worker_leases`; one owner across the fleet. */
export const PUSH_DISPATCHER_LEASE = "push_dispatcher";
/**
 * How long the dispatcher's claim survives without renewal. Long enough that
 * a busy holder never loses it between cycles, short enough that a replica
 * that dies is replaced within a minute.
 */
const LEASE_TTL_MS = 60_000;
/** The running loop's claim, released by stopPushDispatcher. */
let dispatcherLease: WorkerLease | undefined;

/** Lifetime counters, exposed via {@link pushDispatcherStats}. */
let statsDispatched = 0;
let statsDeliveredOk = 0;
let statsSkipped = 0;
let statsGone = 0;
let statsFailed = 0;
let statsDigestsFired = 0;
/** Re-attempts scheduled after a transient failure. */
let statsRetryScheduled = 0;
/** Subscriptions pruned for using up their transient-failure attempts. */
let statsPrunedFailed = 0;

/** Pending live createMessage jobs, drained FIFO. */
const queue: PushJob[] = [];

/** Resolved by {@link pokePushDispatcher} to wake an idle loop. */
let wake: (() => void) | null = null;
export interface PushDispatcherOpts {
  /** Read-state DB handle (read_positions, notification_state, push_subscriptions, …). */
  db: DbLike;
}

/**
 * Start the global push dispatcher. Idempotent. Called once at startup.
 *
 * The loop delivers only while this process holds the dispatcher's lease (see
 * `workers/lease.ts`). Both kinds of work it owns are the holder's: the queued
 * live jobs, which every replica enqueues for itself, and the time-based
 * digests in `notification_state`, which are durable.
 */
export function startPushDispatcher(opts: PushDispatcherOpts): void {
  if (started) return;
  dispatcherDb = opts.db;
  started = true;
  stopped = false;
  const lease = new WorkerLease({
    name: PUSH_DISPATCHER_LEASE,
    ttlMs: LEASE_TTL_MS,
  });
  dispatcherLease = lease;
  loopPromise = (async () => {
    await lease.start();
    try {
      await runDispatcherLoop(lease);
    } finally {
      // However the loop ends, the claim goes with it: a crashed owner that
      // kept renewing would hold every other replica at bay.
      await lease.stop();
    }
  })().catch((err) => {
    log.error("[push-dispatcher] loop crashed:", err);
  });
}

/**
 * Wait for the background loop to exit, then hand the lease back. Used by
 * the appserver's shutdown path.
 */
export async function stopPushDispatcher(): Promise<void> {
  stopped = true;
  const fn = wake;
  wake = null;
  fn?.();
  const p = loopPromise;
  loopPromise = undefined;
  if (p) await p;
  // Hand the dispatcher to another replica now, rather than making it wait
  // out the TTL of a claim this process will never renew.
  await dispatcherLease?.stop();
  dispatcherLease = undefined;
}


export function pushDispatcherStats(): {
  queueDepth: number;
  dispatched: number;
  deliveredOk: number;
  skipped: number;
  gone: number;
  failed: number;
  digestsFired: number;
  retryScheduled: number;
  prunedFailed: number;
} {
  return {
    queueDepth: queue.length,
    dispatched: statsDispatched,
    deliveredOk: statsDeliveredOk,
    skipped: statsSkipped,
    gone: statsGone,
    failed: statsFailed,
    digestsFired: statsDigestsFired,
    retryScheduled: statsRetryScheduled,
    prunedFailed: statsPrunedFailed,
  };
}

/**
 * Enqueue live createMessage jobs and wake an idle loop. Cheap and safe to
 * call frequently: if the loop is busy draining, extra pokes just append to
 * the queue. Called by the `StreamManager` on every live createMessage batch
 * (skipped for backfill, matching the embed-sweeper gate).
 */
export function pokePushDispatcher(jobs: PushJob[]): void {
  if (jobs.length === 0) return;
  if (!started) return; // dispatcher not running
  for (const j of jobs) queue.push(j);
  const fn = wake;
  if (fn) fn();
}

/** The loop body; see `startPushDispatcher` for the lease contract. */
async function runDispatcherLoop(lease: WorkerLease): Promise<void> {
  const db = dispatcherDb;
  if (!db) return;

  while (!stopped) {
    try {
      const drained = await lease.runIfHeld(async () => {
        // Re-attempts first: a row whose backoff elapsed is work the lease
        // holder owes, and it applies whether or not live jobs are queued —
        // a busy loop must not starve a parked device forever.
        await _runPushRetrySweep(db);
        const batch = queue.splice(0, queue.length);
        if (batch.length > 0) {
          await processBatch(db, batch);
          return true; // keep draining if more arrived
        }
        // Idle: run the Engaged digest sweep (catches 1h-elapsed batches even
        // with no new pokes), then wait for a poke or the periodic poll.
        await _runDigestSweep(db);
        return false;
      });
      // Another replica owns the dispatcher: its own queue and the shared
      // digest rows are its work. Keep this process's queued jobs for whoever
      // holds the lease next (this process included) and poll.
      if (!drained) {
        await waitForWake(await idleWaitMs(db));
      }
    } catch (err) {
      // Outer resilience: an unexpected throw must not permanently kill the
      // process-wide loop. Log, pause, continue.
      log.error("[push-dispatcher] cycle threw (continuing):", err);
      await waitForWake(IDLE_POLL_MS);
    }
  }
}

/**
 * How long the loop may idle: the poll interval, or less when a parked
 * subscription's backoff expires sooner — otherwise a 30s backoff would wait
 * out the full minute before its re-attempt runs.
 */
async function idleWaitMs(db: DbLike): Promise<number> {
  let earliest: number | null;
  try {
    earliest = await selectEarliestRetryAt(db);
  } catch {
    // A DB error here is not worth failing the cycle: the poll re-runs it.
    return IDLE_POLL_MS;
  }
  if (earliest == null) return IDLE_POLL_MS;
  return Math.max(0, Math.min(IDLE_POLL_MS, earliest - Date.now()));
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
 * Re-attempt deliveries whose backoff has elapsed. Bounded by
 * {@link SWEEP_BATCH_LIMIT} per cycle, so a large parked backlog drains
 * gradually instead of racing out at once.
 *
 * The work is selected from `push_subscriptions`, not from an in-memory
 * queue: a parked row survives a restart, and whichever replica holds the
 * dispatcher lease picks it up.
 */
export async function _runPushRetrySweep(
  db: DbLike,
  now: number = Date.now(),
): Promise<void> {
  const due = await selectDueSubscriptions(db, now, SWEEP_BATCH_LIMIT);
  if (due.length === 0) return;
  await mapWithConcurrency(due, CONCURRENCY, async (sub) => {
    if (sub.retryPayload == null) {
      // The payload was cleared between scheduling and now (a re-registration,
      // or the user unsubscribed). Nothing is owed: settle the row.
      await clearDeliveryFailure(db, sub);
      return;
    }
    const body = sub.retryPayload;
    await attemptDelivery(db, sub, body, retryTopic(body));
  });
}

/**
 * The coalescing topic for a stored payload, derived from the room it names.
 * The body is what was persisted, so the topic is re-derived rather than
 * stored a second time. Undefined when the body carries no usable room id —
 * the delivery still goes out, it just is not coalesced.
 */
function retryTopic(payload: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null && "roomId" in parsed) {
      const { roomId } = parsed;
      if (typeof roomId === "string" && roomId !== "") return roomTopic(roomId);
    }
  } catch {
    // A stored body we cannot parse cannot carry a topic.
  }
  return undefined;
}

/**
 * Offer one payload to one stored subscription and act on the transport's
 * verdict. This is the only place a stored row meets a transport, so the
 * outcome policy lives here once for every transport and every path (a live
 * delivery and a re-attempt differ only in which body they hand over).
 *
 *  - `delivered` — the row is settled: no failure outstanding.
 *  - `gone` — the destination is dead; the row is pruned.
 *  - `skipped` — nothing was attempted, so no attempt is charged. A row that
 *    was parked is settled, because leaving its backoff in the past would make
 *    the sweep re-select it every cycle.
 *  - `retry` — the attempt failed transiently: park the row with a backoff,
 *    or prune it once it has used up {@link maxRetryAttempts}.
 */
async function attemptDelivery(
  db: DbLike,
  sub: PushSubscriptionRow,
  body: string,
  topic: string | undefined,
): Promise<void> {
  const endpointLabel = sub.endpoint.slice(0, 60);
  let service = "unknown";
  try {
    service = new URL(sub.endpoint).hostname;
  } catch {
    // Non-URL endpoint (a native device token, say) — leave "unknown".
  }
  const label = `kind=${sub.kind} service=${service} endpoint=${endpointLabel}…`;

  const transport = PUSH_TRANSPORTS[sub.kind];
  if (!transport) {
    // A row stored for a transport this build doesn't run. Count it as a
    // failure so the gap is visible instead of silently dropping pushes, and
    // settle any backoff so the sweep does not re-select it forever.
    await clearDeliveryFailure(db, sub);
    statsFailed++;
    log.warn(`[push-deliver] FAILED unknown transport ${label}`);
    return;
  }

  let res: PushOutcome;
  try {
    res = await transport.deliver(
      {
        kind: sub.kind,
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        expirationTime: sub.expirationTime,
      },
      body,
      { topic, urgency: "normal" },
    );
  } catch (err) {
    // A transport must not throw; one that does is treated as a transient
    // failure rather than killing the batch.
    res = { outcome: "retry", status: null, error: err };
  }

  if (res.outcome === "delivered") {
    await clearDeliveryFailure(db, sub);
    statsDeliveredOk++;
    log.debug(`[push-deliver] OK ${label} status=${res.status ?? "?"}`);
    return;
  }
  if (res.outcome === "gone") {
    // Destination unsubscribed / expired — prune so we never retry it.
    await pruneSubscriptionByEndpoint(db, sub.endpoint);
    statsGone++;
    log.info(`[push-deliver] GONE (pruned) ${label}`);
    return;
  }
  if (res.outcome === "skipped") {
    // Nothing was attempted (an unconfigured transport, or a device it cannot
    // reach). Counted apart from `delivered` so a pipeline that is not
    // actually delivering never reads as healthy, and apart from `retry` so a
    // rollout gap is not reported as an outage.
    if (sub.retryAfter != null) await clearDeliveryFailure(db, sub);
    statsSkipped++;
    log.debug(`[push-deliver] SKIPPED ${label}`);
    return;
  }

  const error = res.error instanceof Error ? res.error.message : String(res.error);
  statsFailed++;
  const max = maxRetryAttempts();
  // Scheduled from the attempt this failure becomes, not the one it followed:
  // the first failure waits the shortest backoff.
  const attempts = await recordDeliveryFailure(
    db,
    sub,
    Date.now() + retryBackoffMs(sub.attempts + 1),
    error,
    body,
  );
  if (attempts == null) {
    // The row was pruned between the read and this write (a sibling delivery
    // for another user row sharing the endpoint, or an unregister). There is
    // nothing left to park or prune.
    return;
  }
  if (attempts >= max) {
    // Written off. The line is `GONE (pruned)`-shaped on purpose: to an
    // operator both mean "this destination left the table", and the `after=`
    // suffix says how it got there.
    await pruneSubscriptionByEndpoint(db, sub.endpoint);
    statsPrunedFailed++;
    log.warn(
      `[push-deliver] GONE (pruned, after=${attempts}) ${label} status=${res.status ?? "?"}: ${error}`,
    );
    return;
  }
  statsRetryScheduled++;
  log.warn(
    `[push-deliver] RETRY scheduled attempt=${attempts}/${max} ${label} status=${res.status ?? "?"}: ${error}`,
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
  // and the user's unread count is derived from `read_positions`, not from
  // this table, so nothing user-visible is lost.
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
    // The batch is named after its most recent sender, so this is the author a
    // reader who hides them would be shown. Delivering to that reader is the
    // one way this path can name a hidden author, and it runs without a caller
    // present, so there is nothing a reveal could apply to.
    if (meta?.authorDid != null && (await hiddenBy(row.userDid)).has(meta.authorDid)) {
      // Mark notified all the same: the reader is not waiting to be told, and
      // leaving the row due would re-run this check every sweep until the batch
      // ages out.
      await markNotified(db, row.userDid, row.roomId);
      return;
    }

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
    // Mark notified regardless of delivery outcome: the batch is finished as
    // far as this table is concerned. A failed delivery is not lost — the
    // subscription row keeps the payload and re-attempts it
    // (`_runPushRetrySweep`) — so leaving the row due would only re-fire the
    // same digest every sweep on top of that parked re-attempt.
    await deliverPayload(db, row.userDid, payload);
    await markNotified(db, row.userDid, row.roomId);
    statsDigestsFired++;
  });
}

/**
 * Deliver one payload to all of a user's subscription endpoints, with
 * per-room `topic` coalescing. Shared by the on-event path (`processBatch`)
 * and the time-based sweep. Failures are logged, never thrown to the caller.
 *
 * Each stored row names its transport in `kind` and is handed to that
 * transport by {@link attemptDelivery}; the outcome (`delivered`/`gone`/
 * `skipped`/`retry`) drives the same parking, pruning, counting and logging
 * for every transport, so adding one never touches this policy.
 *
 * A row already parked in backoff is still attempted: a new message is newer
 * than the payload the park is holding, and a delivery that lands settles the
 * row. When this attempt fails too, the parked payload is replaced with this
 * one, so the re-attempt carries the message the user is actually waiting for.
 *
 * Exported for the transport-seam test: it is the single place a stored
 * subscription meets a transport, so a test can drive routing without the
 * background loop.
 */
export async function deliverPayload(
  db: DbLike,
  userDid: string,
  payload: PushPayload,
): Promise<void> {
  const subs = await selectSubscriptions(db, userDid);
  if (subs.length === 0) return;
  const body = JSON.stringify(payload);
  const topic = roomTopic(payload.roomId);
  await mapWithConcurrency(subs, subs.length, (sub) =>
    attemptDelivery(db, sub, body, topic),
  );
}

/**
 * Resolve after `ms`, or immediately when {@link pokePushDispatcher} fires or
 * the loop has been told to stop.
 *
 * The stop check is here rather than at the call site because a caller's check
 * and this registration cannot be atomic across an `await`: a stop landing in
 * between would otherwise leave the loop parked for a full idle poll with
 * nobody to wake it, and `stopPushDispatcher` waiting on it.
 */
function waitForWake(ms: number): Promise<void> {
  if (stopped) return Promise.resolve();
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
 * Stopping waits for the loop to leave its current cycle, so it can't cycle
 * against a closed DB after teardown, and releases the lease.
 */
export async function _resetPushDispatcher(): Promise<void> {
  await stopPushDispatcher();
  dispatcherDb = undefined;
  started = false;
  queue.length = 0;
  statsDispatched = 0;
  statsDeliveredOk = 0;
  statsSkipped = 0;
  statsGone = 0;
  statsFailed = 0;
  statsDigestsFired = 0;
  statsRetryScheduled = 0;
  statsPrunedFailed = 0;
}
