/**
 * Qdrant message indexer — async, out-of-band.
 *
 * The materialiser does no search work synchronously; instead
 * `applyChunkSideEffects` enqueues search jobs here; a background
 * worker loop drains the queue: reads the message's materialised rows from
 * its per-space DB, extracts the plaintext, computes the sparse BM25 vector,
 * and upserts the point to Qdrant.
 *
 * Design (mirrors the embed sweeper's write→poke→drain pattern):
 * - The queue is an in-memory array. The appserver is a single Bun process
 *   and materialization is serialized per stream, so no lock is needed.
 * - Jobs carry `{ spaceDid, messageId }` for index/upsert and
 *   `{ messageId }` for delete. The worker re-reads the DB, so edited
 *   messages enqueue the same shape as creates (idempotent upsert).
 * - Indexing is eventually consistent by design: a just-sent message may
 *   not appear in search for a beat. Search is never the source of truth.
 * - When Qdrant is not configured (`getQdrantClient()` returns null) the
 *   loop no-ops and the queue drains instantly — the appserver runs fine
 *   without Qdrant, and the boot backfill sweeper picks everything up once
 *   Qdrant is enabled.
 */

import type { DbLike } from "../db/types.ts";
import { openSpaceDb } from "../db/db.ts";
import { getQdrantClient, upsertMessage, deleteMessage, ensureMessagesCollection, isStorageFullError, type QdrantClientLike } from "./qdrantSearch.ts";
import { encodeSparse, type SparseVector } from "./bm25.ts";
import { extractMessageText } from "./text.ts";
import { log } from "../log.ts";
import { WorkerLease } from "../workers/lease.ts";
import { mapWithConcurrency } from "../concurrency.ts";

// ─── Configuration ──────────────────────────────────────────────────────

/** Max messages to process per drain batch. */
const INDEX_BATCH = 50;
/** How often to poll the queue while idle (no pokes). */
const IDLE_POLL_MS = 5_000;
/**
 * Exponential backoff floor for Qdrant/DB failures, so a down Qdrant
 * doesn't cause a tight retry loop.
 */
const RETRY_BASE_MS = 1_000;
/** Retry cap — one attempt per minute at most. */
const RETRY_CAP_MS = 60_000;

// ─── Queue ──────────────────────────────────────────────────────────────

interface IndexJob {
  kind: "index";
  spaceDid: string;
  messageId: string;
}

interface DeleteJob {
  kind: "delete";
  messageId: string;
}

type SearchJob = IndexJob | DeleteJob;

const queue: SearchJob[] = [];

// ─── Singleton state ────────────────────────────────────────────────────

/** The indexer's row in `worker_leases`; one owner across the fleet. */
export const SEARCH_INDEXER_LEASE = "search_indexer";
/**
 * How long the indexer's claim survives without renewal. Long enough that a
 * busy holder never loses it between renewals, short enough that a replica
 * that dies is replaced within a minute.
 */
const LEASE_TTL_MS = 60_000;

let started = false;
/** The running loop's claim, released by stopSearchIndexer. */
let indexerLease: WorkerLease | undefined;
/** Resolved when the background loop exits. Used by stopSearchIndexer. */
let loopPromise: Promise<void> | undefined;
/** Resolved by pokeSearchIndexer to wake an idle loop immediately. */
let wake: (() => void) | null = null;
/** Consecutive Qdrant errors — escalates backoff so a down Qdrant doesn't tight-loop. */
let nextErrors = 0;
/** Timestamp (ms) until which the loop should wait before touching Qdrant. */
let lastBackoffUntil = 0;
/** Number of drains currently in flight (loop or explicit flush). */
let activeDrains = 0;


// ─── Stats (for /health/search) ─────────────────────────────────────────
let statsIndexedOk = 0;
let statsIndexedFailed = 0;
/** Message of the most recent indexer failure (systemic or per-job). */
let statsLastError: string | null = null;

// ─── Enqueue (called from applyChunkSideEffects) ────────────────────────

/**
 * Enqueue an index/upsert for a message. Called from
 * applyChunkSideEffects for createMessage and editMessage — the worker
 * re-reads the message rows, so edited content is picked up automatically.
 */
export function enqueueIndexMessage(
  spaceDid: string,
  messageId: string,
): void {
  queue.push({ kind: "index", spaceDid, messageId });
  pokeSearchIndexer();
}

/** Enqueue a point delete for a deleted message. */
export function enqueueDeleteMessage(messageId: string): void {
  queue.push({ kind: "delete", messageId });
  pokeSearchIndexer();
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

/**
 * Start the background indexer loop. Idempotent — safe to call multiple
 * times. Called once at appserver startup (see `index.ts`).
 *
 * The loop works only while this process holds the indexer's lease (see
 * `workers/lease.ts`). On a replica that does not, queued work waits for the
 * holder, and is drained here if this process ever takes over.
 */
export function startSearchIndexer(): void {
  if (started) return;
  started = true;
  const lease = new WorkerLease({
    name: SEARCH_INDEXER_LEASE,
    ttlMs: LEASE_TTL_MS,
  });
  indexerLease = lease;
  loopPromise = (async () => {
    await lease.start();
    try {
      await runIndexerLoop(lease);
    } finally {
      // However the loop ends, the claim goes with it: a crashed owner that
      // kept renewing would hold every other replica at bay.
      await lease.stop();
    }
  })().catch((err) => {
    log.error("[search-indexer] loop crashed:", err);
  });
}

/**
 * Wake the indexer to drain immediately. Cheap and safe to call frequently:
 * if a drain is already in progress this is a no-op.
 */
export function pokeSearchIndexer(): void {
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
}

/**
 * Wait for the background loop to exit, then hand the lease back.
 * Idempotent. Used by tests and by the appserver's shutdown path.
 */
export async function stopSearchIndexer(): Promise<void> {
  started = false;
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
  const p = loopPromise;
  loopPromise = undefined;
  if (p) await p;
  // Hand the indexer to another replica now, rather than making it wait out
  // the TTL of a claim this process will never renew.
  await indexerLease?.stop();
  indexerLease = undefined;
}

/** Snapshot of indexer state for the `/health/search` endpoint. */
export function searchIndexerStats(): {
  queueLength: number;
  indexedOk: number;
  indexedFailed: number;
  /** Message of the most recent failure, or null. */
  lastError: string | null;
} {
  return {
    queueLength: queue.length,
    indexedOk: statsIndexedOk,
    indexedFailed: statsIndexedFailed,
    lastError: statsLastError,
  };
}

/** Reset queue + stats (tests only). Does not stop a running loop. */
export function _resetSearchIndexer(): void {
  queue.length = 0;
  statsIndexedOk = 0;
  statsIndexedFailed = 0;
  nextErrors = 0;
  lastBackoffUntil = 0;
  statsLastError = null;
}

/** The loop body; see `startSearchIndexer` for the lease contract. */
async function runIndexerLoop(lease: WorkerLease): Promise<void> {
  for (;;) {
    if (!started) return; // allow clean exit via stopSearchIndexer
    try {
      // If Qdrant has been erroring, wait out the backoff before touching
      // it again — don't hammer a down service in a tight loop.
      const now = Date.now();
      if (now < lastBackoffUntil) {
        await waitForWake(lastBackoffUntil - now);
        continue;
      }
      const drained = await lease.runIfHeld(async () => {
        const jobs = queue.splice(0, INDEX_BATCH);
        if (jobs.length === 0) return false;
        await drainJobs(jobs);
        return true; // more likely pending — loop without waiting
      });
      // Another replica owns the indexer: keep this process's queued jobs for
      // whoever holds the lease next (this process included) and poll.
      if (drained === null) {
        await waitForWake(IDLE_POLL_MS);
        continue;
      }
      if (drained) continue;
      await waitForWake(IDLE_POLL_MS);
    } catch (err) {
      // Outer resilience (mirrors the embed sweeper): an unexpected throw
      // must not permanently kill the process-wide loop.
      log.error("[search-indexer] drain threw (continuing):", err);
      await waitForWake(IDLE_POLL_MS);
    }
  }
}

/** Process a batch of jobs with bounded concurrency. */
async function drainJobs(jobs: SearchJob[]): Promise<void> {
  activeDrains++;
  try {
    const client = getQdrantClient();
    if (!client) {
      // Qdrant not configured — drain and drop (the boot backfill re-indexes
      // everything once Qdrant is enabled).
      return;
    }
    try {
      await ensureMessagesCollection(client);
    } catch (err) {
      // A down Qdrant must not crash the appserver — back off and retry the
      // same jobs next cycle.
      markError(err);
      queue.unshift(...jobs);
      return;
    }
    markOk();

    // Process with bounded concurrency, but stop the batch on the first
    // SYSTEMIC failure (Qdrant out of storage / down). Every remaining job
    // would fail identically, and marking them failed DROPS the messages —
    // they are then only recoverable by the backfill sweep. Instead, back
    // off and re-queue the untouched remainder so nothing is lost and the
    // next cycle retries once capacity is restored.
    let systemic: unknown = null;
    await mapWithConcurrency(jobs, 4, async (job) => {
      if (systemic !== null) return;
      try {
        if (job.kind === "delete") {
          await deleteMessage(client!, job.messageId);
        } else {
          await indexOne(client!, job);
        }
        statsIndexedOk++;
      } catch (err) {
        if (isStorageFullError(err)) {
          systemic = err;
          statsLastError = `Qdrant storage full (507): ${err instanceof Error ? err.message : String(err)}`;
          log.error("[search-indexer] Qdrant is out of storage; backing off:", err);
          return;
        }
        statsIndexedFailed++;
        statsLastError = `job ${job.messageId}: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(`[search-indexer] job failed (${job.messageId}):`, err);
      }
    });
    if (systemic !== null) {
      markError(systemic);
      queue.unshift(...jobs);
    }
  } finally {
    activeDrains--;
  }
}

/**
 * Drain the queue and wait until no drain is in flight (tests). The
 * background loop may have already spliced some jobs; this finishes whatever
 * remains and waits for the in-flight drain to settle, so a test can search
 * deterministically right after materializing.
 */
export async function flushSearchQueue(): Promise<void> {
  for (;;) {
    const jobs = queue.splice(0, queue.length);
    if (jobs.length === 0) {
      if (activeDrains === 0) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, 10);
      await promise;
      clearTimeout(timer);
      continue;
    }
    await drainJobs(jobs);
  }
}

/** Re-read one message's rows and upsert its sparse vector. */
async function indexOne(client: QdrantClientLike, job: IndexJob): Promise<void> {
  const db = openSpaceDb(job.spaceDid);
  const row = await loadMessageRow(db, job.messageId);
  if (row === null || row.room === null) return; // not a message / not materialised yet

  const text = extractMessageText(row.mimeType, row.data);
  if (text === "") return; // nothing indexable

  const sparse: SparseVector = encodeSparse(text);
  const threadId = await resolveThreadId(db, row.room);
  const timestamp = row.timestamp != null
    ? new Date(row.timestamp).toISOString()
    : new Date().toISOString();

  await upsertMessage(client, job.messageId, sparse, {
    spaceDid: job.spaceDid,
    roomId: row.room,
    threadId,
    authorDid: row.authorDid ?? "",
    timestamp,
  });
}

/** Base row needed to index a message. */
interface MessageRow {
  room: string | null;
  mimeType: string | null;
  data: Buffer | Uint8Array | null;
  timestamp: number | null;
  authorDid: string | null;
}

/** Read the message's room/content/author rows from its per-space DB. */
async function loadMessageRow(
  db: DbLike,
  messageId: string,
): Promise<MessageRow | null> {
  const row = await db
    .query(
      `select e.room as room,
              cc.mime_type as mime_type,
              cc.data as data,
              cc.timestamp as timestamp,
              author_e.tail as author_did
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges author_e
           on author_e.head = e.id and author_e.label = 'author'
        where e.id = ?`,
    )
    .get<{
      room: string | null;
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      timestamp: number | null;
      author_did: string | null;
    }>(messageId);
  if (row === null) return null;
  return {
    room: row.room,
    mimeType: row.mime_type,
    data: row.data,
    timestamp: row.timestamp,
    authorDid: row.author_did,
  };
}

/** The message's own room when that room is a thread, else null. */
async function resolveThreadId(db: DbLike, roomId: string): Promise<string | null> {
  const row = await db
    .query("select label from comp_room where entity = ?")
    .get<{ label: string | null }>(roomId);
  return row?.label === "space.roomy.thread" ? roomId : null;
}

/**
 * Resolve after `ms`, or immediately when {@link pokeSearchIndexer} fires or
 * the loop has been told to stop.
 *
 * The stop check is here rather than at the call site because the caller's
 * check and this registration cannot be atomic across an `await`: a stop that
 * lands in between would otherwise leave the loop parked for a full idle poll
 * with nobody to wake it, and `stopSearchIndexer` waiting on it.
 */
function waitForWake(ms: number): Promise<void> {
  if (!started) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    wake = null;
    resolve();
  }, ms);
  wake = () => {
    clearTimeout(timer);
    resolve();
  };
  return promise;
}

/** Escalate backoff on consecutive errors, capped. */
function markError(err: unknown): void {
  nextErrors = Math.min(nextErrors + 1, 8);
  const backoffMs = Math.min(RETRY_BASE_MS * 2 ** (nextErrors - 1), RETRY_CAP_MS);
  lastBackoffUntil = Date.now() + backoffMs;
  log.warn(
    `[search-indexer] error (#${nextErrors}); backing off ${Math.round(backoffMs / 1000)}s:`,
    err,
  );
}

/** Reset the backoff after a successful cycle. */
function markOk(): void {
  if (nextErrors !== 0) nextErrors = 0;
  if (lastBackoffUntil !== 0) lastBackoffUntil = 0;
}
