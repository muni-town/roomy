/**
 * Durable job queue + mutex for the Roomy agent responder.
 *
 * Every incoming mention/reply (and, later, cron-scheduled prompts) is
 * appended to a queue file on disk as a job. A single worker loop claims
 * jobs one at a time under a file-based lock, so concurrent omp runs are
 * prevented even when two responder processes race on the same machine
 * (duplicate bridge pipelines) or a future cron job enqueues work.
 *
 * The queue file IS the machine-readable state contract for cron scripts:
 * they can read it (via `cli queue status` or directly) and append jobs with
 * `--only-if-empty` so a job never stacks behind a backlog.
 *
 * File layout (both under the same directory):
 *   <queue-file>       — JSON queue state (enqueued / active / done)
 *   <queue-file>.lock  — holder + pid + heartbeat + acquiredAt
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { MentionEvent } from "./respond.js";

/** Cap on completed jobs kept in the queue file for status visibility. */
export const DONE_CAP = 50;

/** Cron jobs carry their own prompt and post target (no session machinery). */
export interface CronJobPayload {
  spaceId: string;
  roomId: string;
  text: string;
  /** Message id to thread the reply under, when the job is a reply. */
  parent?: string;
}

export type QueueJobPayload =
  | { kind: "mention"; evt: MentionEvent }
  | { kind: "cron"; cron: CronJobPayload };

export type QueueJobStatus = "queued" | "active" | "done" | "failed";

export interface QueueJob {
  id: string;
  kind: "mention" | "cron";
  payload: QueueJobPayload;
  status: QueueJobStatus;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

/**
 * A finished job as retained in `done[]`. Status visibility only needs the
 * job's identity and timing — the payload (a mention event carries the whole
 * message body) is dead weight at ~18 KB per entry, so `done[]` drops it.
 */
export interface QueueJobSummary {
  id: string;
  kind: "mention" | "cron";
  status: QueueJobStatus;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface QueueState {
  version: 1;
  /** Monotonic job counter — stable ordering key for readers. */
  jobSeq: number;
  enqueued: QueueJob[];
  active: QueueJob | null;
  done: QueueJobSummary[];
  updatedAt: number;
}

export interface LockInfo {
  holder?: string;
  pid?: number;
  acquiredAt?: number;
  heartbeatAt?: number;
  stale: boolean;
}

/**
 * A done entry read back from a file written before `done[]` carried
 * summaries may still hold the full job payload. Drop it: the entry parses,
 * and the next write persists the summary form (that write is the migration —
 * no schema-version bump).
 */
const toDoneSummary = (entry: QueueJobSummary): QueueJobSummary => {
  const { payload: _legacyPayload, ...summary } = entry as QueueJobSummary & {
    payload?: QueueJobPayload;
  };
  return summary;
};

const EMPTY_STATE = (): QueueState => ({
  version: 1,
  jobSeq: 0,
  enqueued: [],
  active: null,
  done: [],
  updatedAt: Date.now(),
});

/**
 * File-backed FIFO queue. Writes are atomic (write temp + rename) so a
 * concurrent reader (cron) never sees a torn file. Single-writer-per-process
 * by convention; the responder is the primary writer, cron appends via
 * `cli queue push` (read-modify-write under the same atomic rename).
 */
export class QueueStore {
  #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  /** Append a job and return it. */
  enqueue(kind: QueueJob["kind"], payload: QueueJobPayload): QueueJob {
    const state = this.#read();
    const seq = state.jobSeq + 1;
    const job: QueueJob = {
      id: randomUUID(),
      kind,
      payload,
      status: "queued",
      enqueuedAt: Date.now(),
    };
    state.jobSeq = seq;
    state.enqueued.push(job);
    this.#write(state);
    return job;
  }

  /**
   * Enqueue only when the queue is empty and nothing is active. Returns the
   * job, or `null` when the queue is busy — the cron "add only when idle"
   * contract.
   */
  enqueueIfIdle(kind: QueueJob["kind"], payload: QueueJobPayload): QueueJob | null {
    const state = this.#read();
    if (state.enqueued.length > 0 || state.active !== null) return null;
    const seq = state.jobSeq + 1;
    const job: QueueJob = {
      id: randomUUID(),
      kind,
      payload,
      status: "queued",
      enqueuedAt: Date.now(),
    };
    state.jobSeq = seq;
    state.enqueued.push(job);
    this.#write(state);
    return job;
  }

  /** Head of the queue, without claiming. */
  peek(): QueueJob | null {
    const state = this.#read();
    return state.enqueued[0] ?? null;
  }

  /**
   * Claim the head job (FIFO): moves it to `active` with a start timestamp.
   * Only the head may be claimed — callers must have peeked the same job.
   */
  claim(id: string): QueueJob | null {
    const state = this.#read();
    const head = state.enqueued[0];
    if (!head || head.id !== id) return null;
    state.enqueued.shift();
    const now = Date.now();
    const job: QueueJob = { ...head, status: "active", startedAt: now };
    state.active = job;
    state.updatedAt = now;
    this.#write(state);
    return job;
  }

  /** Finish the active job as done or failed. */
  finish(id: string, status: "done" | "failed", error?: string): void {
    const state = this.#read();
    if (!state.active || state.active.id !== id) return;
    const now = Date.now();
    const { payload: _unretained, ...summary } = {
      ...state.active,
      status,
      finishedAt: now,
      ...(error !== undefined ? { error } : {}),
    };
    state.active = null;
    state.done.push(summary);
    if (state.done.length > DONE_CAP) state.done.splice(0, state.done.length - DONE_CAP);
    state.updatedAt = now;
    this.#write(state);
  }

  /**
   * Recover after a crash/restart: an `active` job whose lock is absent or
   * stale (the previous process died mid-job) goes back to the head of the
   * queue. Called on startup, before the worker loop starts.
   */
  requeueStaleActive(staleLock: boolean): void {
    const state = this.#read();
    if (!state.active || !staleLock) return;
    const job: QueueJob = { ...state.active, status: "queued", startedAt: undefined };
    state.active = null;
    state.enqueued.unshift(job);
    state.updatedAt = Date.now();
    this.#write(state);
  }

  /** Snapshot of the queue state (the cron-facing view). */
  status(): QueueState {
    return this.#read();
  }

  #read(): QueueState {
    try {
      const raw = fs.readFileSync(this.#file, "utf8");
      const parsed = JSON.parse(raw) as Partial<QueueState>;
      if (parsed?.version !== 1) return EMPTY_STATE();
      return {
        version: 1,
        jobSeq: typeof parsed.jobSeq === "number" ? parsed.jobSeq : 0,
        enqueued: Array.isArray(parsed.enqueued) ? parsed.enqueued : [],
        active: parsed.active ?? null,
        done: Array.isArray(parsed.done) ? parsed.done.map(toDoneSummary) : [],
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      };
    } catch {
      return EMPTY_STATE();
    }
  }

  #write(state: QueueState): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.#file);
  }
}

/**
 * File-based mutex with a heartbeat and stale takeover. Guarantees single
 * execution across processes on the same machine (responder duplicates, cron
 * vs responder). A crashed holder is reclaimed after `ttlMs` without a
 * heartbeat.
 */
export class FileLock {
  #file: string;
  #ttlMs: number;

  constructor(lockFile: string, ttlMs = 120_000) {
    this.#file = lockFile;
    this.#ttlMs = ttlMs;
  }

  /**
   * Try to acquire. Returns false when the lock is held by a live holder
   * (heartbeat within TTL). Stale locks are taken over atomically.
   */
  tryAcquire(holder: string, pid: number): boolean {
    const info = this.#read();
    if (info && !info.stale && info.holder !== holder) return false;
    const now = Date.now();
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ holder, pid, acquiredAt: now, heartbeatAt: now }),
    );
    fs.renameSync(tmp, this.#file);
    // Confirm the rename actually won (a concurrent takeover could have
    // renamed over us between the write and our rename).
    const confirm = this.#read();
    return confirm?.holder === holder;
  }

  /** Refresh the heartbeat so the lock stays live. */
  heartbeat(holder: string, pid: number): void {
    const info = this.#read();
    if (!info || info.holder !== holder) return;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ ...info, heartbeatAt: Date.now() }),
    );
    fs.renameSync(tmp, this.#file);
  }

  /** Release only when we still hold the lock. */
  release(holder: string): void {
    const info = this.#read();
    if (!info || info.holder !== holder) return;
    try {
      fs.unlinkSync(this.#file);
    } catch {
      // already gone
    }
  }

  info(): LockInfo | null {
    return this.#read();
  }

  #read(): LockInfo | null {
    try {
      const raw = fs.readFileSync(this.#file, "utf8");
      const parsed = JSON.parse(raw) as Partial<LockInfo>;
      const heartbeatAt =
        typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : 0;
      const stale = Date.now() - heartbeatAt > this.#ttlMs;
      return {
        holder: parsed.holder,
        pid: parsed.pid,
        acquiredAt: parsed.acquiredAt,
        heartbeatAt,
        stale,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Responder boot heal. Takes the queue lock, requeues a job left `active` by
 * a crashed holder, and RELEASES the lock before returning.
 *
 * The heal must run at boot: a job orphaned in `active` by a dead responder
 * is otherwise never requeued, because the pump only runs when something is
 * `enqueued` — with an empty queue the drain timer has nothing to trigger on,
 * so the orphan would sit invisible forever.
 *
 * The release is the important half. Lock freshness is the "job in flight"
 * signal every external reader relies on (`self-check.sh queue_busy`,
 * `cli queue status`, the cron only-if-idle contract). A responder that takes
 * the lock at boot and heartbeats it while sitting idle therefore reads as
 * permanently busy, and every scheduled tick skips until a job happens to
 * arrive — which on an idle worker may be never. Mutual exclusion is
 * unaffected: the pump acquires the lock per job and releases it after each.
 *
 * Returns the lock info observed before the heal (null when the lock was
 * free), so the caller can report a live foreign holder. When a live foreign
 * holder exists nothing is touched and the lock is left exactly as found.
 */
export function bootHeal(
  queue: QueueStore,
  lock: FileLock,
  holder: string,
  pid: number,
): LockInfo | null {
  const before = lock.info();
  if (before && before.holder !== holder && !before.stale) return before;
  if (lock.tryAcquire(holder, pid)) {
    queue.requeueStaleActive(true);
    lock.release(holder);
  }
  return before;
}
