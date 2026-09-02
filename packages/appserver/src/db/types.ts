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
  /**
   * Optional (per-space split, Phase 1): a routed handle whose requests
   * target the per-space DB for `spaceDid`. Absent on sync adapters used in
   * tests that don't exercise dual-write.
   */
  forSpace?(spaceDid: string): DbLike;
  /**
   * Optional (blue-green): a routed handle pinned to the temp `.sqlite.new`
   * rebuild DB for `spaceDid` (a fresh, new-schema DB). `applyBatch` targets
   * this during rematerialisation. Absent on sync adapters used in tests
   * that don't exercise blue-green rebuilds.
   */
  forSpaceRebuild?(spaceDid: string): DbLike;
  /**
   * Optional (blue-green): whether `spaceDid` is currently rebuilding (has a
   * temp `.sqlite.new` being materialised). Checked by the single write gate
   * in `StreamManager.sendEvents()` before the event-log insert.
   */
  isSpaceRebuilding?(spaceDid: string): Promise<boolean>;
  /**
   * Optional (blue-green): start a rebuild for `spaceDid` — creates the temp
   * `.sqlite.new` file with the current schema and marks it rebuilding.
   * Idempotent: returns `{ ok: true }` even if already rebuilding.
   */
  spaceRebuildBegin?(spaceDid: string): Promise<{ ok: boolean }>;
  /**
   * Optional (blue-green): atomically swap the temp `.sqlite.new` over the
   * canonical file, dropping the old DB, and flip routing. Idempotent:
   * `{ committed: false }` when nothing is rebuilding.
   */
  spaceRebuildCommit?(spaceDid: string): Promise<{ committed: boolean }>;
  /**
   * Optional (blue-green): abandon a rebuild — delete the temp file and clear
   * the rebuilding flag; the old DB keeps serving. `{ aborted: false }` when
   * nothing is rebuilding.
   */
  spaceRebuildAbort?(spaceDid: string): Promise<{ aborted: boolean }>;
  /**
   * Optional (blue-green): whether the canonical per-space DB for `spaceDid`
   * is on the current schema version. Used by rematerialisation to decide
   * begin→replay→commit vs incremental catch-up.
   */
  checkSpaceSchema?(spaceDid: string): Promise<{ current: boolean }>;
  /**
   * Optional (per-space split, Phase 1): a routed handle whose requests
   * target the global DB. Absent on sync adapters used in tests that don't
   * exercise dual-write.
   */
  global?(): DbLike;
  /**
   * Optional (read-state): a routed handle whose requests target the
   * read-state DB (durable user-owned state like membership intent). Absent
   * on sync adapters used in tests that don't exercise dual-write.
   */
  readState?(): DbLike;
  /**
   * Optional (event log): a routed handle whose requests target the raw
   * event-log DB. Absent on sync adapters used in tests that don't exercise
   * the event log directly.
   */
  events?(): DbLike;
  /**
   * Optional (Phase 3): backfill the global `entity_space` index from a
   * per-space DB's `entities` table. Absent on sync adapters used in tests
   * that don't exercise the entity→space index.
   */
  backfillEntitySpace?(spaceDid: string): Promise<{ backfilled: number }>;
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
    | "health"
    | "backfillEntitySpace"
    | "spaceRebuildBegin"
    | "spaceRebuildCommit"
    | "spaceRebuildAbort"
    | "isSpaceRebuilding"
    | "checkSpaceSchema";
  /** SQL string (for query/run/exec/prepare). */
  sql?: string;
  /** Bind parameters (for query/run/prepareRun/prepareAll/prepareGet). */
  params?: unknown[];
  /** Which DB the request targets. Defaults to the event-log DB. */
  targetDb?: "main" | "space" | "global" | "readstate" | "events";
  /** Per-space DB selector (required when targetDb is "space"). */
  spaceDid?: string;
  /** Blue-green route for a "space" target: canonical read-serving DB vs the
   *  temp `.sqlite.new` rebuild DB. Defaults to "canonical" (never wipes). */
  route?: "canonical" | "rebuild";
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
    eventsDbPath?: string;
    spacesDir?: string;
    globalDbPath?: string;
    schemaVersion?: string;
    readStateSchemaVersion?: string;
    spaceSchemaVersion?: string;
    globalSchemaVersion?: string;
    maxSpaceDbs?: number;
    /**
     * Worker role (Phase 4 / system-worker split). "space" workers only open
     * per-space DBs and reject shared-DB requests; "global", "readstate" and
     * "events" workers each own exactly one of the shared DBs (the global
     * worker can also open per-space DBs for the entity_space backfill);
     * "system" is the legacy combined role. Defaults to "system".
     */
    role?: "space" | "system" | "global" | "readstate" | "events";
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
