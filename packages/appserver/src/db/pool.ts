/**
 * Worker pool for per-space DBs (Phase 4 of docs/plans/per-space-dbs.md).
 *
 * The per-space DBs are the source of truth for space data, but they all run
 * on a single `Bun.Worker` thread today, serializing every SQLite operation
 * through one `postMessage` queue. This module fans the per-space DBs out
 * across a pool of N workers, hash-routed by `spaceDid`, so different
 * spaces' materialization and reads run on different threads in parallel.
 *
 * Topology:
 *   - N "space" workers: open per-space DBs (`data/spaces/<spaceDid>.sqlite`)
 *     lazily, LRU-cached. `hash(spaceDid) % N` pins a space to one worker so
 *     its handle + prepared statements stay warm.
 *   - 1 "global" worker: owns the global DB (`data/global.sqlite`), and can
 *     open per-space DBs for the entity_space backfill.
 *   - 1 "readstate" worker: owns the read-state DB (`data/roomy-readstate.sqlite`).
 *   - 1 "events" worker: owns the event-log DB (`data/roomy-events.sqlite`).
 *
 * The three shared DBs each get a DEDICATED worker so a slow query on any one
 * doesn't serialize the other two (previously global, read-state and event-log
 * all shared a single "system" worker thread).
 *
 * The pool is a drop-in replacement for the single `WorkerLink` behind
 * `openSpaceDb`: `forSpace(spaceDid)` returns an `AsyncDatabase` pinned to the
 * owning worker with the same `{ targetDb: \"space\", spaceDid }` route.
 */

import { AsyncDatabase, WorkerLink } from "./asyncDatabase.ts";
import type { DbLike } from "./types.ts";

/**
 * Stable string hash (FNV-1a 32-bit) over the space DID. Deterministic across
 * restarts so a space always lands on the same worker (keeps its LRU handle +
 * prepared statements warm). Changing the pool size re-distributes spaces,
 * which is safe — caches just re-warm.
 */
export function hashSpace(spaceDid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < spaceDid.length; i++) {
    h ^= spaceDid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface PoolInitOptions {
  readStateDbPath?: string;
  eventsDbPath?: string;
  spacesDir?: string;
  globalDbPath?: string;
  readStateSchemaVersion?: string;
  spaceSchemaVersion?: string;
  globalSchemaVersion?: string;
  maxSpaceDbs?: number;
}

/**
 * Owns N per-space workers + 3 dedicated workers (global, readstate, events).
 * Handles are `AsyncDatabase`s
 * routed to the correct worker, so callers can't tell the pool from the old
 * single worker.
 */
export class DatabasePool {
  readonly #poolLinks: WorkerLink[];
  readonly #globalLink: WorkerLink;
  readonly #readStateLink: WorkerLink;
  readonly #eventsLink: WorkerLink;
  readonly #size: number;

  constructor(size: number, workerPath: string) {
    this.#size = Math.max(1, size);
    this.#poolLinks = Array.from(
      { length: this.#size },
      () => new WorkerLink(workerPath),
    );
    this.#globalLink = new WorkerLink(workerPath);
    this.#readStateLink = new WorkerLink(workerPath);
    this.#eventsLink = new WorkerLink(workerPath);
  }

  get size(): number {
    return this.#size;
  }

  /** A handle pinned to the pool worker that owns `spaceDid`. */
  forSpace(spaceDid: string): AsyncDatabase {
    const idx = hashSpace(spaceDid) % this.#size;
    return new AsyncDatabase(this.#poolLinks[idx]!, {
      targetDb: "space",
      spaceDid,
    });
  }

  /** A handle pinned to the temp `.sqlite.new` rebuild DB for `spaceDid`
   *  (blue-green). Same worker as `forSpace` so rebuild state stays local. */
  forSpaceRebuild(spaceDid: string): AsyncDatabase {
    const idx = hashSpace(spaceDid) % this.#size;
    return new AsyncDatabase(this.#poolLinks[idx]!, {
      targetDb: "space",
      spaceDid,
      route: "rebuild",
    });
  }

  /** Start a rebuild for `spaceDid` (idempotent). */
  async spaceRebuildBegin(spaceDid: string): Promise<{ ok: boolean }> {
    return this.forSpace(spaceDid).spaceRebuildBegin(spaceDid);
  }

  /** Atomically swap the rebuild DB over the canonical file (idempotent). */
  async spaceRebuildCommit(spaceDid: string): Promise<{ committed: boolean }> {
    return this.forSpace(spaceDid).spaceRebuildCommit(spaceDid);
  }

  /** Abandon a rebuild; the old DB keeps serving. */
  async spaceRebuildAbort(spaceDid: string): Promise<{ aborted: boolean }> {
    return this.forSpace(spaceDid).spaceRebuildAbort(spaceDid);
  }

  /** Whether `spaceDid` is currently rebuilding. */
  async isSpaceRebuilding(spaceDid: string): Promise<boolean> {
    return this.forSpace(spaceDid).isSpaceRebuilding(spaceDid);
  }

  /** Whether the canonical per-space DB for `spaceDid` is on the current schema. */
  async checkSpaceSchema(spaceDid: string): Promise<{ current: boolean }> {
    return this.forSpace(spaceDid).checkSpaceSchema(spaceDid);
  }

  /** A handle to the global DB's dedicated worker. */
  global(): AsyncDatabase {
    return new AsyncDatabase(this.#globalLink, { targetDb: "global" });
  }

  /** A handle to the read-state DB's dedicated worker. */
  readState(): AsyncDatabase {
    return new AsyncDatabase(this.#readStateLink, { targetDb: "readstate" });
  }

  /** A handle to the event-log DB's dedicated worker. */
  events(): AsyncDatabase {
    return new AsyncDatabase(this.#eventsLink, { targetDb: "events" });
  }

  /** The router handle returned by `openDb()` (see `PooledDatabase`). */
  router(): PooledDatabase {
    return new PooledDatabase(this);
  }

  /**
   * Initialise every worker. Space workers get `role: \"space\"` (per-space
   * DBs only); the global/readstate/events workers each open only the shared
   * DB they own (the global worker also gets per-space access for the
   * entity_space backfill).
   */
  async init(opts: PoolInitOptions): Promise<void> {
    const spaceOpts = {
      spacesDir: opts.spacesDir,
      spaceSchemaVersion: opts.spaceSchemaVersion,
      maxSpaceDbs: opts.maxSpaceDbs,
      role: "space" as const,
    };
    // Post every init message synchronously (before awaiting) so each worker
    // is initialised before any subsequent routed query — the fire-and-forget
    // `openDb()` path relies on message ordering, not on the init promise
    // resolving first.
    const poolPromises = this.#poolLinks.map((l) =>
      l.send({ type: "init", initOpts: spaceOpts }),
    );
    const globalPromise = this.#globalLink.send({
      type: "init",
      initOpts: {
        spacesDir: opts.spacesDir,
        globalDbPath: opts.globalDbPath,
        globalSchemaVersion: opts.globalSchemaVersion,
        spaceSchemaVersion: opts.spaceSchemaVersion,
        maxSpaceDbs: opts.maxSpaceDbs,
        role: "global",
      },
    });
    const readStatePromise = this.#readStateLink.send({
      type: "init",
      initOpts: {
        readStateDbPath: opts.readStateDbPath,
        readStateSchemaVersion: opts.readStateSchemaVersion,
        role: "readstate",
      },
    });
    const eventsPromise = this.#eventsLink.send({
      type: "init",
      initOpts: {
        eventsDbPath: opts.eventsDbPath,
        role: "events",
      },
    });
    await Promise.all([
      ...poolPromises,
      globalPromise,
      readStatePromise,
      eventsPromise,
    ]);
  }

  /** Terminate all workers, rejecting in-flight requests. */
  close(): void {
    for (const l of this.#poolLinks) l.terminate();
    this.#globalLink.terminate();
    this.#readStateLink.terminate();
    this.#eventsLink.terminate();
  }

  /**
   * Per-worker observability (Phase 4 evaluation): pool size and in-flight
   * request counts per worker. Lets an operator see whether load is spreading
   * across the pool and the three shared-DB workers, or collapsing onto one.
   */
  stats(): {
    size: number;
    spaceWorkers: Array<{ pending: number }>;
    globalWorker: { pending: number };
    readStateWorker: { pending: number };
    eventsWorker: { pending: number };
  } {
    return {
      size: this.#size,
      spaceWorkers: this.#poolLinks.map((l) => ({ pending: l.pendingCount })),
      globalWorker: { pending: this.#globalLink.pendingCount },
      readStateWorker: { pending: this.#readStateLink.pendingCount },
      eventsWorker: { pending: this.#eventsLink.pendingCount },
    };
  }
}

/**
 * The router handle returned by `openDb()`. Default operations (query/run/
 * exec/prepare/transaction) target the event-log DB on the events worker;
 * `forSpace`/`global`/`readState`/`events`/`backfillEntitySpace` dispatch to
 * the correct worker. This is what `StreamManager`, `reMaterialize` and the
 * handlers see — it satisfies `DbLike` exactly like the old single-worker
 * `AsyncDatabase` did.
 */
export class PooledDatabase implements DbLike {
  readonly #pool: DatabasePool;
  readonly #events: AsyncDatabase;
  readonly #owned: boolean;

  constructor(pool: DatabasePool, owned = false) {
    this.#pool = pool;
    this.#events = pool.events();
    this.#owned = owned;
  }

  query(sql: string) {
    return this.#events.query(sql);
  }
  prepare(sql: string) {
    return this.#events.prepare(sql);
  }
  exec(sql: string) {
    return this.#events.exec(sql);
  }
  run(sql: string, ...params: unknown[]) {
    return this.#events.run(sql, ...params);
  }
  transaction<T>(steps: Array<{
    type: "query" | "run" | "exec";
    sql: string;
    params?: unknown[];
  }>): Promise<T> {
    return this.#events.transaction<T>(steps);
  }
  async close(): Promise<void> {
    if (this.#owned) this.#pool.close();
  }

  forSpace(spaceDid: string): AsyncDatabase {
    return this.#pool.forSpace(spaceDid);
  }
  forSpaceRebuild(spaceDid: string): AsyncDatabase {
    return this.#pool.forSpaceRebuild(spaceDid);
  }
  isSpaceRebuilding(spaceDid: string): Promise<boolean> {
    return this.#pool.isSpaceRebuilding(spaceDid);
  }
  spaceRebuildBegin(spaceDid: string): Promise<{ ok: boolean }> {
    return this.#pool.spaceRebuildBegin(spaceDid);
  }
  spaceRebuildCommit(spaceDid: string): Promise<{ committed: boolean }> {
    return this.#pool.spaceRebuildCommit(spaceDid);
  }
  spaceRebuildAbort(spaceDid: string): Promise<{ aborted: boolean }> {
    return this.#pool.spaceRebuildAbort(spaceDid);
  }
  checkSpaceSchema(spaceDid: string): Promise<{ current: boolean }> {
    return this.#pool.checkSpaceSchema(spaceDid);
  }
  global(): AsyncDatabase {
    return this.#pool.global();
  }
  readState(): AsyncDatabase {
    return this.#pool.readState();
  }
  events(): AsyncDatabase {
    return this.#pool.events();
  }
  backfillEntitySpace(spaceDid: string): Promise<{ backfilled: number }> {
    // Runs on the global worker, which owns the global DB and can open the
    // per-space DB file for the entity_space backfill.
    return this.#pool.global().backfillEntitySpace(spaceDid);
  }
}
