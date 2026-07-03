// Worker is a global in Bun — no import needed.

import type { WorkerRequest, WorkerResponse } from "./types.ts";

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

  async all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]> {
    if (this.#handle !== undefined) {
      const result = await this.#send({
        type: "prepareAll",
        handle: this.#handle,
        params,
      });
      return result as T[];
    }
    const result = await this.#send({
      type: "query",
      sql: this.#sql,
      params,
      mode: "all",
    });
    return result as T[];
  }

  async get<T = Record<string, unknown>>(
    ...params: unknown[]
  ): Promise<T | null> {
    if (this.#handle !== undefined) {
      const result = await this.#send({
        type: "prepareGet",
        handle: this.#handle,
        params,
      });
      return result as T | null;
    }
    const result = await this.#send({
      type: "query",
      sql: this.#sql,
      params,
      mode: "get",
    });
    return result as T | null;
  }

  async run(
    ...params: unknown[]
  ): Promise<{ changes: number; lastInsertRowid?: number }> {
    if (this.#handle !== undefined) {
      const result = await this.#send({
        type: "prepareRun",
        handle: this.#handle,
        params,
      });
      return result as { changes: number; lastInsertRowid?: number };
    }
    const result = await this.#send({
      type: "run",
      sql: this.#sql,
      params,
    });
    return result as { changes: number; lastInsertRowid?: number };
  }

  async finalize(): Promise<void> {
    if (this.#handle !== undefined) {
      await this.#send({ type: "prepareFinalize", handle: this.#handle });
      this.#handle = undefined;
    }
  }
}

// ─── AsyncDatabase ────────────────────────────────────────────────────────

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class AsyncDatabase {
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

  /** Initialize: open DBs, apply schema, ATTACH read-state. */
  async init(opts: {
    mainDbPath?: string;
    readStateDbPath?: string;
    schemaVersion?: string;
    readStateSchemaVersion?: string;
  }): Promise<{ mainDbPath: string; readStateDbPath: string; version: string }> {
    return this.#send({ type: "init", initOpts: opts }) as Promise<{
      mainDbPath: string;
      readStateDbPath: string;
      version: string;
    }>;
  }

  query(sql: string): AsyncStatement {
    return new AsyncStatement((req) => this.#send(req), sql);
  }

  async prepare(sql: string): Promise<AsyncStatement> {
    const { handle } = (await this.#send({
      type: "prepare",
      sql,
    })) as { handle: number };
    return new AsyncStatement((req) => this.#send(req), sql, handle);
  }

  async exec(sql: string): Promise<void> {
    await this.#send({ type: "exec", sql });
  }

  async run(
    sql: string,
    ...params: unknown[]
  ): Promise<{ changes: number; lastInsertRowid?: number }> {
    return this.#send({ type: "run", sql, params }) as Promise<{
      changes: number;
      lastInsertRowid?: number;
    }>;
  }

  async transaction<T>(
    steps: Array<{
      type: "query" | "run" | "exec";
      sql: string;
      params?: unknown[];
    }>,
  ): Promise<T> {
    return this.#send({ type: "transaction", steps }) as Promise<T>;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#send({ type: "close" });
    this.#closed = true;
    this.#worker.terminate();
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

  #send(req: Omit<WorkerRequest, "id">): Promise<unknown> {
    if (this.#closed) throw new Error("Database is closed");
    const id = String(this.#nextId++);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timeout = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`Request timed out: ${req.type}`));
    }, REQUEST_TIMEOUT_MS);
    this.#pending.set(id, { resolve, reject, timeout });
    this.#worker.postMessage({ ...req, id });
    return promise;
  }
}
