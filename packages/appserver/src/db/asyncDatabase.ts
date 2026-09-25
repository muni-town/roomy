// Worker is a global in Bun — no import needed.

import type { WorkerRequest, WorkerResponse } from "./types.ts";
import { metrics } from "../metrics.ts";

// ─── Error types ──────────────────────────────────────────────────────────

export class WorkerCrashedError extends Error {
  constructor() {
    super("Worker crashed");
    this.name = "WorkerCrashedError";
  }
}

// ─── AsyncStatement ───────────────────────────────────────────────────────

export class AsyncStatement {
  #send: (req: Omit<WorkerRequest, "id">) => Promise<unknown>;
  #sql: string;
  #handle?: number;

  constructor(
    send: (req: Omit<WorkerRequest, "id">) => Promise<unknown>,
    sql: string,
    handle?: number,
  ) {
    this.#send = send;
    this.#sql = sql;
    this.#handle = handle;
  }

  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]> {
    if (this.#handle !== undefined) {
      return this.#send({
        type: "prepareAll",
        handle: this.#handle,
        params,
      }) as Promise<T[]>;
    }
    return this.#send({
      type: "query",
      sql: this.#sql,
      params,
      mode: "all",
    }) as Promise<T[]>;
  }

  get<T = Record<string, unknown>>(
    ...params: unknown[]
  ): Promise<T | null> {
    if (this.#handle !== undefined) {
      return this.#send({
        type: "prepareGet",
        handle: this.#handle,
        params,
      }) as Promise<T | null>;
    }
    return this.#send({
      type: "query",
      sql: this.#sql,
      params,
      mode: "get",
    }) as Promise<T | null>;
  }

  run(
    ...params: unknown[]
  ): Promise<{ changes: number; lastInsertRowid?: number }> {
    if (this.#handle !== undefined) {
      return this.#send({
        type: "prepareRun",
        handle: this.#handle,
        params,
      }) as Promise<{ changes: number; lastInsertRowid?: number }>;
    }
    return this.#send({
      type: "run",
      sql: this.#sql,
      params,
    }) as Promise<{ changes: number; lastInsertRowid?: number }>;
  }

  finalize(): Promise<void> {
    if (this.#handle === undefined) return Promise.resolve();
    const p = this.#send({ type: "prepareFinalize", handle: this.#handle });
    // Release the handle on success regardless of whether the caller awaits.
    // `p` already carries the no-op catch from send(), so a fire-and-forget
    // finalize (post-teardown) is a handled rejection. The derived `.then`
    // promise resolves either way (both handlers present), so it cannot
    // itself surface an unhandled rejection.
    p.then(
      () => {
        this.#handle = undefined;
      },
      () => {
        // Rejection is already surfaced to callers via `p`.
      },
    );
    return p as Promise<void>;
  }
}

// ─── WorkerLink ───────────────────────────────────────────────────────────

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

// Counts DB requests that hit the 30s timeout — the direct signal for pool
// saturation / N+1 bottlenecks (see metrics.ts). Labeled by request type
// (query / run / prepareRun / ...) so a spike shows which operation stalled.
const dbTimeouts = metrics.counter(
  "roomy_db_timeouts_total",
  "DB worker requests that exceeded the request timeout.",
  ["type"],
);

/**
 * Owns one Bun.Worker thread and the request/response correlation for it.
 * Multiple `AsyncDatabase` handles can share one link; each handle stamps a
 * route (main / per-space / global DB) onto every request it sends.
 */
export class WorkerLink {
  #worker: Worker;
  #pending = new Map<string, PendingEntry>();
  #nextId = 0;
  #closed = false;

  constructor(workerPath: string) {
    this.#worker = new Worker(workerPath);

    this.#worker.onmessage = (event: MessageEvent) => {
      const data = event.data as WorkerResponse;
      const { id, result, error } = data;
      const entry = this.#pending.get(id);
      if (!entry) return;
      this.#pending.delete(id);
      clearTimeout(entry.timeout);
      if (error) {
        entry.reject(new Error(error));
      } else {
        entry.resolve(result);
      }
    };

    this.#worker.onerror = () => {
      const entries = [...this.#pending.entries()];
      this.#pending.clear();
      for (const [, entry] of entries) {
        clearTimeout(entry.timeout);
        entry.reject(new WorkerCrashedError());
      }
    };
  }

  /** Send a request, optionally stamped with a DB route. */
  send(req: Omit<WorkerRequest, "id">, route?: DbRoute): Promise<unknown> {
    if (this.#closed) {
      // The link is already shut down. Return a rejected-but-handled promise
      // instead of throwing synchronously: an `async` wrapper would otherwise
      // convert the throw into a brand-new (unhandled-able) rejection. The
      // no-op catch marks it handled; awaited callers still observe the
      // "Database is closed" error.
      const { promise, reject } = Promise.withResolvers<unknown>();
      reject(new Error("Database is closed"));
      promise.catch(() => {});
      return promise;
    }
    const id = String(this.#nextId++);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeout = setTimeout(() => {
      this.#pending.delete(id);
      dbTimeouts.inc({ type: req.type });
      reject(new Error(`Request timed out: ${req.type}`));
    }, REQUEST_TIMEOUT_MS);
    this.#pending.set(id, { resolve, reject, timeout });
    this.#worker.postMessage({ ...req, ...route, id });
    // Some callers fire-and-forget DB requests (background loops, teardown
    // races). When the worker is terminated mid-request, `terminate()`
    // rejects every pending promise; a dropped promise would surface as an
    // unhandled rejection and fail the whole test run. Attach a no-op catch
    // so the rejection is considered handled — awaited callers still observe
    // it via the returned promise.
    promise.catch(() => {});
    return promise;
  }

  /** Terminate the worker immediately, rejecting all pending requests. */
  terminate(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Reject all pending requests so callers don't hang.
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Database closed"));
    }
    this.#pending.clear();
    this.#worker.terminate();
  }

  /** Number of in-flight (pending) requests on this worker. */
  get pendingCount(): number {
    return this.#pending.size;
  }
}

// ─── DbRoute ──────────────────────────────────────────────────────────────

/** Which DB a handle's requests target on the shared worker. */
export interface DbRoute {
  targetDb?: "space" | "global" | "readstate" | "events";
  spaceDid?: string;
  /** Blue-green route for a "space" target: canonical vs temp rebuild DB. */
  route?: "canonical" | "rebuild";
}

// ─── AsyncDatabase ────────────────────────────────────────────────────────

export class AsyncDatabase {
  #link: WorkerLink;
  #route?: DbRoute;
  /** True when this handle owns the worker link (isolated mode) and must
   *  terminate it on close. Shared handles leave the link to closeDb(). */
  #ownedLink: boolean;

  constructor(link: WorkerLink, route?: DbRoute, ownedLink = false) {
    this.#link = link;
    this.#route = route;
    this.#ownedLink = ownedLink;
  }

  /** A handle that routes requests to the per-space DB for `spaceDid`. */
  forSpace(spaceDid: string): AsyncDatabase {
    return new AsyncDatabase(this.#link, { targetDb: "space", spaceDid });
  }

  /** A handle pinned to the temp `.sqlite.new` rebuild DB for `spaceDid`.
   *  First request creates the fresh new-schema rebuild DB and marks the
   *  space as rebuilding (blue-green). */
  forSpaceRebuild(spaceDid: string): AsyncDatabase {
    return new AsyncDatabase(this.#link, {
      targetDb: "space",
      spaceDid,
      route: "rebuild",
    });
  }

  /** Start a rebuild for `spaceDid` (idempotent). */
  spaceRebuildBegin(spaceDid: string): Promise<{ ok: boolean }> {
    return this.#link.send({ type: "spaceRebuildBegin", spaceDid }) as Promise<{
      ok: boolean;
    }>;
  }

  /** Atomically swap the rebuild DB over the canonical file. */
  spaceRebuildCommit(spaceDid: string): Promise<{ committed: boolean }> {
    return this.#link.send({
      type: "spaceRebuildCommit",
      spaceDid,
    }) as Promise<{ committed: boolean }>;
  }

  /** Abandon a rebuild; the canonical DB keeps serving. */
  spaceRebuildAbort(spaceDid: string): Promise<{ aborted: boolean }> {
    return this.#link.send({
      type: "spaceRebuildAbort",
      spaceDid,
    }) as Promise<{ aborted: boolean }>;
  }

  /** Whether `spaceDid` is currently rebuilding. */
  isSpaceRebuilding(spaceDid: string): Promise<boolean> {
    return this.#link.send({ type: "isSpaceRebuilding", spaceDid }) as Promise<boolean>;
  }

  /** Whether the canonical per-space DB for `spaceDid` is on the current schema. */
  checkSpaceSchema(spaceDid: string): Promise<{ current: boolean }> {
    return this.#link.send({ type: "checkSpaceSchema", spaceDid }) as Promise<{
      current: boolean;
    }>;
  }

  /** A handle that routes requests to the global DB. */
  global(): AsyncDatabase {
    return new AsyncDatabase(this.#link, { targetDb: "global" });
  }

  /** A handle that routes requests to the read-state DB. */
  readState(): AsyncDatabase {
    return new AsyncDatabase(this.#link, { targetDb: "readstate" });
  }

  /** A handle that routes requests to the event-log DB. */
  events(): AsyncDatabase {
    return new AsyncDatabase(this.#link, { targetDb: "events" });
  }

  /** Initialize: open DBs, apply schema, ATTACH read-state. */
  init(opts: {
    mainDbPath?: string;
    readStateDbPath?: string;
    eventsDbPath?: string;
    spacesDir?: string;
    globalDbPath?: string;
    schemaVersion?: string;
    readStateSchemaVersion?: string;
    spaceSchemaVersion?: string;
    globalSchemaVersion?: string;
    maxSpaceDbs?: number;
  }): Promise<{ mainDbPath: string; readStateDbPath: string; version: string }> {
    return this.#link.send({ type: "init", initOpts: opts }) as Promise<{
      mainDbPath: string;
      readStateDbPath: string;
      version: string;
    }>;
  }

  query(sql: string): AsyncStatement {
    return new AsyncStatement((req) => this.#link.send(req, this.#route), sql);
  }

  prepare(sql: string): Promise<AsyncStatement> {
    // Chain the send() result into a statement without an `async` wrapper:
    // an `async` method would wrap the already-handled send() promise in a
    // brand-new outer promise, so a fire-and-forget prepare() (post-teardown)
    // surfaces send()'s rejection as an unhandled rejection. Instead reject
    // our own promise and mark it handled — awaited callers still see the
    // error, dropped callers don't fail the run.
    const { promise, resolve, reject } = Promise.withResolvers<AsyncStatement>();
    this.#link.send({ type: "prepare", sql }, this.#route).then(
      (result) => {
        if (
          result === null ||
          typeof result !== "object" ||
          !("handle" in result) ||
          typeof result.handle !== "number"
        ) {
          reject(new Error("prepare: worker returned no statement handle"));
          return;
        }
        resolve(
          new AsyncStatement(
            (req) => this.#link.send(req, this.#route),
            sql,
            result.handle,
          ),
        );
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
    // no-op catch marks the rejection handled (mirrors WorkerLink.send()).
    promise.catch(() => {});
    return promise;
  }

  exec(sql: string): Promise<void> {
    return this.#link.send({ type: "exec", sql }, this.#route) as Promise<void>;
  }

  run(
    sql: string,
    ...params: unknown[]
  ): Promise<{ changes: number; lastInsertRowid?: number }> {
    return this.#link.send({ type: "run", sql, params }, this.#route) as Promise<{
      changes: number;
      lastInsertRowid?: number;
    }>;
  }

  transaction<T>(
    steps: Array<{
      type: "query" | "run" | "exec";
      sql: string;
      params?: unknown[];
    }>,
  ): Promise<T> {
    return this.#link.send({ type: "transaction", steps }, this.#route) as Promise<T>;
  }

  /**
   * Backfill the global `entity_space` index from a per-space DB's `entities`
   * table (worker-internal). Used on boot to index rooms/messages that were
   * materialized before the index existed. Idempotent.
   */
  backfillEntitySpace(spaceDid: string): Promise<{ backfilled: number }> {
    return this.#link.send({ type: "backfillEntitySpace", spaceDid }) as Promise<{
      backfilled: number;
    }>;
  }

  async close(): Promise<void> {
    if (this.#ownedLink) {
      this.#link.terminate();
    }
    // Shared handles leave the worker link to closeDb().
  }

  /** Terminate the shared worker immediately, rejecting all pending requests. */
  terminate(): void {
    this.#link.terminate();
  }
}
