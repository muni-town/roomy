/**
 * SQLite worker — runs in a Bun.Worker thread.
 *
 * Opens both the materialisation DB and the read-state DB, processes
 * requests via message-passing, and returns results asynchronously.
 *
 * All handlers are synchronous (bun:sqlite is synchronous in the worker
 * thread). Errors are caught and returned as structured { error, errorCode }
 * in the response.
 */

import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRequest, WorkerResponse } from "./types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Cast unknown[] to SQLQueryBindings[] for bun:sqlite. */
function toBindings(params?: unknown[]): SQLQueryBindings[] {
  return (params ?? []) as SQLQueryBindings[];
}

/** Normalise lastInsertRowid (number | bigint) to number | undefined. */
function normaliseRowid(
  rowid: number | bigint | undefined,
): number | undefined {
  if (rowid === undefined || rowid === null) return undefined;
  return Number(rowid);
}

// ─── State ────────────────────────────────────────────────────────────────

let mainDb: Database | null = null;
let readStateDb: Database | null = null;
let eventsDb: Database | null = null;
const preparedStmts = new Map<number, ReturnType<Database["prepare"]>>();
let nextHandle = 1;
let closed = false;

// ─── Schema paths ─────────────────────────────────────────────────────────

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(THIS_DIR, "schema.sql");
const READSTATE_SCHEMA_PATH = join(THIS_DIR, "readStateSchema.sql");
const EVENTS_SCHEMA_PATH = join(THIS_DIR, "eventsSchema.sql");

// ─── Schema helpers (ported from db.ts / readStateDb.ts) ──────────────────

class SchemaVersionMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Schema version mismatch: expected ${expected}, got ${actual}`,
    );
    this.name = "SchemaVersionMismatchError";
  }
}

function initializeSchema(
  db: Database,
  schemaPath: string,
  expectedVersion: string,
): void {
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  const row = db
    .query<{ version: string }, []>(
      "select version from roomy_schema_version where id = 1",
    )
    .get();
  if (!row) {
    db.exec(
      `insert into roomy_schema_version (id, version) values (1, '${expectedVersion}')`,
    );
  } else if (row.version !== expectedVersion) {
    throw new SchemaVersionMismatchError(expectedVersion, row.version);
  }
}

interface Migration {
  version: number;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    up(db: Database) {
      db.exec(`
        create table if not exists user_thread_activity (
          user_did      text not null,
          thread_id     text not null,
          last_active_at integer not null,
          updated_at    integer not null default (unixepoch() * 1000),
          primary key (user_did, thread_id)
        ) strict
      `);
      db.exec(`
        create index if not exists idx_user_thread_activity_user
          on user_thread_activity(user_did, last_active_at desc)
      `);
    },
  },
];

function initializeReadStateSchema(
  db: Database,
  schemaPath: string,
  expectedVersion: string,
): void {
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  const row = db
    .query<{ version: string }, []>(
      "select version from readstate_schema_version where id = 1",
    )
    .get();
  if (!row) {
    db.exec(
      `insert into readstate_schema_version (id, version) values (1, '${expectedVersion}')`,
    );
    return;
  }

  const currentVersion = parseInt(row.version, 10);
  const expectedNum = parseInt(expectedVersion, 10);

  if (currentVersion < expectedNum) {
    const upsertVersion = db.prepare(
      "update readstate_schema_version set version = ? where id = 1",
    );
    for (const migration of MIGRATIONS) {
      if (
        migration.version > currentVersion &&
        migration.version <= expectedNum
      ) {
        db.transaction(() => {
          migration.up(db);
          upsertVersion.run(String(migration.version));
        })();
      }
    }
  }
}

// ─── Message handler ──────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent) => {
  const req = event.data as WorkerRequest;
  try {
    if (closed) {
      const response: WorkerResponse = {
        id: req.id,
        error: "Worker is closed",
        errorCode: "WORKER_CLOSED",
      };
      self.postMessage(response);
      return;
    }
    const result = handleRequest(req);
    const response: WorkerResponse = { id: req.id, result };
    self.postMessage(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode =
      err instanceof SchemaVersionMismatchError
        ? "SCHEMA_MISMATCH"
        : "INTERNAL_ERROR";
    const response: WorkerResponse = {
      id: req.id,
      error: message,
      errorCode,
    };
    self.postMessage(response);
  }
};

function handleRequest(req: WorkerRequest): unknown {
  switch (req.type) {
    case "init":
      return handleInit(req);
    case "query":
      return handleQuery(req);
    case "run":
      return handleRun(req);
    case "exec":
      return handleExec(req);
    case "prepare":
      return handlePrepare(req);
    case "prepareRun":
      return handlePrepareRun(req);
    case "prepareAll":
      return handlePrepareAll(req);
    case "prepareGet":
      return handlePrepareGet(req);
    case "prepareFinalize":
      return handlePrepareFinalize(req);
    case "transaction":
      return handleTransaction(req);
    case "close":
      return handleClose();
    case "health":
      return { ok: true };
    default:
      throw new Error(`Unknown request type: ${req.type}`);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────

function handleInit(req: WorkerRequest): {
  mainDbPath: string;
  readStateDbPath: string;
  version: string;
} {
  const opts = req.initOpts!;
  const mainPath = opts.mainDbPath ?? "data/roomy.sqlite";
  const readStatePath =
    opts.readStateDbPath ?? "data/roomy-readstate.sqlite";

  // Open main DB
  mkdirSync(dirname(mainPath), { recursive: true });
  mainDb = new Database(mainPath, { create: true });
  mainDb.exec("pragma journal_mode = wal");
  mainDb.exec("pragma synchronous = normal");
  mainDb.exec("pragma foreign_keys = on");

  try {
    initializeSchema(mainDb, SCHEMA_PATH, opts.schemaVersion ?? "");
  } catch (err) {
    if (err instanceof SchemaVersionMismatchError) {
      mainDb.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(mainPath + suffix);
        } catch {
          /* already gone */
        }
      }
      mkdirSync(dirname(mainPath), { recursive: true });
      mainDb = new Database(mainPath, { create: true });
      mainDb.exec("pragma journal_mode = wal");
      mainDb.exec("pragma synchronous = normal");
      mainDb.exec("pragma foreign_keys = on");
      initializeSchema(mainDb, SCHEMA_PATH, opts.schemaVersion ?? "");
    } else {
      throw err;
    }
  }

  // Open read-state DB
  if (readStatePath === ":memory:") {
    // For in-memory read-state DB, ATTACH directly and apply schema on mainDb
    mainDb.exec("attach database ':memory:' as readstate");
    const schemaSql = readFileSync(READSTATE_SCHEMA_PATH, "utf-8");
    // Prepend "readstate." to table names in CREATE TABLE statements so they
    // land in the attached schema rather than the main database schema.
    const prefixedSql = schemaSql.replace(
      /create\s+table\s+(if\s+not\s+exists\s+)?(\w+)/gi,
      (_match, ifNotExists: string | undefined, tableName: string) => {
        if (tableName === "readstate_schema_version") {
          return `create table ${ifNotExists ?? ""}${tableName}`;
        }
        return `create table ${ifNotExists ?? ""}readstate.${tableName}`;
      },
    );
    mainDb.exec(prefixedSql);
  } else {
    mkdirSync(dirname(readStatePath), { recursive: true });
    readStateDb = new Database(readStatePath, { create: true });
    readStateDb.exec("pragma journal_mode = wal");
    readStateDb.exec("pragma synchronous = normal");
    readStateDb.exec("pragma foreign_keys = on");
    initializeReadStateSchema(
      readStateDb,
      READSTATE_SCHEMA_PATH,
      opts.readStateSchemaVersion ?? "",
    );

    // ATTACH read-state to main DB
    const row = readStateDb
      .query<{ file: string }, []>("pragma database_list")
      .all()
      .find((r) => r.file !== "");
    if (!row) throw new Error("Cannot resolve read-state DB path");
    mainDb.exec(
      `attach database '${row.file.replace(/'/g, "''")}' as readstate`,
    );
  }

  // Open events DB (append-only, never wiped — no schema version)
  const eventsPath = opts.eventsDbPath ?? "data/roomy-events.sqlite";
  mkdirSync(dirname(eventsPath), { recursive: true });
  eventsDb = new Database(eventsPath, { create: true });
  eventsDb.exec("pragma journal_mode = wal");
  eventsDb.exec("pragma synchronous = normal");
  const eventsSchemaSql = readFileSync(EVENTS_SCHEMA_PATH, "utf-8");
  eventsDb.exec(eventsSchemaSql);

  // ATTACH events DB to main DB
  const eventsRow = eventsDb
    .query<{ file: string }, []>("pragma database_list")
    .all()
    .find((r) => r.file !== "");
  if (!eventsRow) throw new Error("Cannot resolve events DB path");
  mainDb.exec(
    `attach database '${eventsRow.file.replace(/'/g, "''")}' as events`,
  );

  return {
    mainDbPath: mainPath,
    readStateDbPath: readStatePath,
    version: opts.schemaVersion ?? "",
  };
}

// ─── Query handlers ───────────────────────────────────────────────────────

function handleQuery(req: WorkerRequest): unknown {
  const stmt = mainDb!.query(req.sql!);
  if (req.mode === "get") {
    return stmt.get(...toBindings(req.params)) ?? null;
  }
  return stmt.all(...toBindings(req.params));
}

function handleRun(req: WorkerRequest): {
  changes: number;
  lastInsertRowid?: number;
} {
  const result = mainDb!.run(req.sql!, ...toBindings(req.params));
  return {
    changes: result.changes,
    lastInsertRowid: normaliseRowid(result.lastInsertRowid),
  };
}

function handleExec(req: WorkerRequest): void {
  mainDb!.exec(req.sql!);
}

function handlePrepare(req: WorkerRequest): { handle: number } {
  const handle = nextHandle++;
  preparedStmts.set(handle, mainDb!.prepare(req.sql!));
  return { handle };
}

function handlePrepareRun(req: WorkerRequest): {
  changes: number;
  lastInsertRowid?: number;
} {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  const result = stmt.run(...toBindings(req.params));
  return {
    changes: result.changes,
    lastInsertRowid: normaliseRowid(result.lastInsertRowid),
  };
}

function handlePrepareAll(req: WorkerRequest): unknown[] {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  return stmt.all(...toBindings(req.params));
}

function handlePrepareGet(req: WorkerRequest): unknown {
  const stmt = preparedStmts.get(req.handle!);
  if (!stmt)
    throw new Error(`Unknown prepared statement handle: ${req.handle}`);
  return stmt.get(...toBindings(req.params)) ?? null;
}

function handlePrepareFinalize(req: WorkerRequest): void {
  const stmt = preparedStmts.get(req.handle!);
  if (stmt) {
    stmt.finalize();
    preparedStmts.delete(req.handle!);
  }
}

function handleTransaction(req: WorkerRequest): unknown {
  let lastResult: unknown = undefined;
  const run = mainDb!.transaction(() => {
    for (const step of req.steps ?? []) {
      switch (step.type) {
        case "query":
          lastResult = mainDb!.prepare(step.sql).all(
            ...toBindings(step.params),
          );
          break;
        case "run":
          lastResult = mainDb!.run(step.sql, ...toBindings(step.params));
          break;
        case "exec":
          mainDb!.exec(step.sql);
          lastResult = undefined;
          break;
      }
    }
  });
  run();
  return lastResult;
}

function handleClose(): void {
  closed = true;
  preparedStmts.clear();
  // DETACH events from mainDb before closing either, so no access to eventsDb
  // via the ATTACH after mainDb drops it.
  if (mainDb) {
    mainDb.exec("detach database events");
  }
  if (eventsDb) {
    eventsDb.close();
    eventsDb = null;
  }
  if (mainDb) {
    mainDb.close();
    mainDb = null;
  }
  if (readStateDb) {
    readStateDb.close();
    readStateDb = null;
  }
}
