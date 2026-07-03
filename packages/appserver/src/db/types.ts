/**
 * Minimal async-compatible DB interface.
 *
 * During migration, functions accept this type instead of raw `Database`.
 * The real `Database` is wrapped in an adapter; `AsyncDatabase` implements
 * it natively.
 */
export interface DbLike {
  query(sql: string): {
    all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
    get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | null>;
  };
  prepare(sql: string): Promise<{
    all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
    get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | null>;
    run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }>;
  }>;
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }>;
  transaction<T>(steps: Array<{
    type: "query" | "run" | "exec";
    sql: string;
    params?: unknown[];
  }>): Promise<T>;
  close(): Promise<void>;
}

// ─── Worker message protocol types ──────────────────────────────────────

/** Request sent from the main thread to the SQLite worker. */
export interface WorkerRequest {
  /** Monotonic request ID for correlating responses. */
  id: string;
  /** Operation type. */
  type:
    | "query"
    | "run"
    | "exec"
    | "prepare"
    | "prepareRun"
    | "prepareAll"
    | "prepareGet"
    | "prepareFinalize"
    | "transaction"
    | "close"
    | "init"
    | "health";
  /** SQL string (for query/run/exec/prepare). */
  sql?: string;
  /** Bind parameters (for query/run/prepareRun/prepareAll/prepareGet). */
  params?: unknown[];
  /** Query mode: "all" (default) or "get" (single row). */
  mode?: "all" | "get";
  /** Prepared statement handle ID (for prepareRun/prepareAll/prepareGet/prepareFinalize). */
  handle?: number;
  /** Transaction steps (for transaction type). */
  steps?: Array<{
    type: "query" | "run" | "exec";
    sql: string;
    params?: unknown[];
  }>;
  /** Init options (for init type). */
  initOpts?: {
    mainDbPath?: string;
    readStateDbPath?: string;
    schemaVersion?: string;
    readStateSchemaVersion?: string;
  };
}

/** Response from the SQLite worker to the main thread. */
export interface WorkerResponse {
  /** Echo of the request ID. */
  id: string;
  /** Result data. Type depends on the request type. */
  result?: unknown;
  /** Error message if the operation failed. */
  error?: string;
  /** Error code for structured error handling. */
  errorCode?: string;
}
