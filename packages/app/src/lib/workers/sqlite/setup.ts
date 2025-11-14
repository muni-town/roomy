import initSqlite3, {
  type Database,
  type OpfsSAHPoolDatabase,
  type Sqlite3Static,
  type PreparedStatement,
} from "@sqlite.org/sqlite-wasm";
import { IdCodec } from "../encoding";
import type { SqlStatement } from "../types";
import { decodeTime, isValid as isValidUlid, ulid } from "ulidx";
import { patchApply, patchFromText } from "diff-match-patch-es";

let sqlite3: Sqlite3Static | null = null;
let db: OpfsSAHPoolDatabase | Database | null = null;
let initPromise: Promise<void> | null = null;
let vfsType: string | null = null;

export function isDatabaseReady(): boolean {
  return !!db;
}

export function getVfsType(): string | null {
  return vfsType;
}

/** This is a queue of all operations recorded by our global sqlite authorizer */
let authorizerQueue: Action[] = [];
const authorizer: Parameters<
  Sqlite3Static["capi"]["sqlite3_set_authorizer"]
>[1] = (_arg, actionCode, arg1, arg2, database, triggerOrView) => {
  authorizerQueue.push({
    actionCode: actionCodeName(actionCode),
    arg1: arg1 || undefined,
    arg2: arg2 || undefined,
    database: database || undefined,
    triggerOrView: triggerOrView || undefined,
  });
  return 0;
};

export async function initializeDatabase(dbName: string): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!sqlite3) {
      sqlite3 = await initSqlite3({
        print: console.log,
        printErr: console.error,
      });
    }

    let lastErr: unknown = null;

    // Strategy 1: Try OpfsSAHPoolVfs (best performance, no COOP/COEP required)
    // Retry a few times because SAH Pool can transiently fail during context handoff
    console.log("Attempting to initialize with OpfsSAHPoolVfs...");
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const pool = await sqlite3.installOpfsSAHPoolVfs({});
        db = new pool.OpfsSAHPoolDb(dbName);
        db.exec(`pragma locking_mode = exclusive`);
        db.exec(`pragma synchronous = normal`);
        db.exec(`pragma journal_mode = wal`);
        vfsType = "opfs-sahpool";
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }

    // Fall back to in-memory database
    if (!db) {
      console.warn(
        "All persistent storage options failed, falling back to in-memory database...",
        lastErr,
      );
      try {
        db = new sqlite3.oo1.DB(":memory:");
        db.exec(`pragma locking_mode = exclusive`);
        db.exec(`pragma synchronous = normal`);
        db.exec(`pragma journal_mode = memory`);
        vfsType = "memory";
        lastErr = null; // Clear the error since we succeeded
        console.warn(
          "⚠️  Using in-memory database - data will not persist across page reloads",
        );
      } catch (e) {
        console.error("In-memory database fallback also failed:", e);
        lastErr = e;
      }
    }

    if (!db) {
      const error = new Error(
        `Failed to initialize database with any available VFS. Last error: ${lastErr}`,
      );
      console.error("Database initialization failed:", error);
      throw error;
    }

    console.log(`✓ Database initialized successfully using VFS: ${vfsType}`);

    // Set an authorizer function that will allow us to track reads and writes to the database
    sqlite3.capi.sqlite3_set_authorizer(db, authorizer, 0);

    // Parse a binary ID to it's string representation
    db.createFunction("id", (_ctx, blob) => {
      if (blob instanceof Uint8Array) {
        return IdCodec.dec(blob);
      } else {
        return blob;
      }
    });
    // Format a string ID to it's binary format
    db.createFunction(
      "print",
      (_ctx, ...args) => {
        console.log("%c[sqlite log]", "color: green", ...args);
        return null;
      },
      { arity: -1, deterministic: false },
    );
    // Format a string ID to it's binary format
    db.createFunction("make_id", (_ctx, id) => {
      if (typeof id == "string") {
        return IdCodec.enc(id);
      } else {
        return id;
      }
    });
    db.createFunction("is_ulid", (_ctx, id) => {
      if (typeof id == "string") {
        return isValidUlid(id) ? 1 : 0;
      } else if (id instanceof Uint8Array) {
        return isValidUlid(IdCodec.dec(id)) ? 1 : 0;
      } else {
        return 0;
      }
    });
    db.createFunction("ulid_timestamp", (_ctx, id) => {
      if (typeof id == "string") {
        return decodeTime(id);
      } else if (id instanceof Uint8Array) {
        return decodeTime(IdCodec.dec(id));
      } else {
        return id;
      }
    });
    // Create a ULID from a timestamp (for range queries using the index)
    db.createFunction("timestamp_to_ulid", (_ctx, timestamp) => {
      if (typeof timestamp === "number") {
        // Create a ULID with the given timestamp
        const generatedUlid = ulid(timestamp);
        // Encode it to binary blob format for comparison with indexed entity IDs
        return IdCodec.enc(generatedUlid);
      }
      return null;
    });
    db.createFunction("apply_dmp_patch", (_ctx, content, patch) => {
      if (!(typeof content == "string" && typeof patch == "string"))
        throw "Expected two string arguments to apply_dpm_patch()";

      const [patched, _successful] = patchApply(
        patchFromText(patch),
        content,
      ) as [string, boolean[]];

      return patched;
    });
  })();
  await initPromise;
}

export type QueryResult<Row = { [key: string]: unknown }> = {
  rows?: Row[];
  ok?: true;
} & {
  actions: Action[];
};
export async function executeQuery(
  statement: SqlStatement,
): Promise<QueryResult> {
  if (!db && initPromise) await initPromise;
  if (!db || !sqlite3) throw new Error("database_not_initialized");

  try {
    const { prepared, actions } = await prepareSql(statement);
    const result = runPreparedStatement(prepared);

    await updateLiveQueries(actions);

    return { ...result, actions };
  } catch (e) {
    const message =
      (e instanceof Error ? e.message : String(e)) +
      " " +
      JSON.stringify(statement);
    throw new Error(message);
  }
}

const preparedSqlCache: Map<string, PreparedStatement> = new Map();
async function prepareSql(
  statement: SqlStatement,
): Promise<{ prepared: PreparedStatement; actions: Action[] }> {
  if (!db && initPromise) await initPromise;
  if (!db || !sqlite3) throw new Error("database_not_initialized");

  authorizerQueue = [];
  let prepared = statement.cache
    ? preparedSqlCache.get(statement.sql)
    : undefined;
  if (!prepared) {
    prepared = db.prepare(statement.sql);
    if (statement.cache) {
      preparedSqlCache.set(statement.sql, prepared);
    }
  }
  if (statement.params) prepared.bind(statement.params);
  const actions = [...authorizerQueue];
  return { prepared, actions };
}

function runPreparedStatement(
  statement: PreparedStatement,
): { ok: true } | { rows: { [key: string]: unknown }[] } {
  const rows = [];
  const columnCount = statement.columnCount;
  const columnNames = Array.from(Array(columnCount).keys()).map((x) =>
    statement.getColumnName(x),
  );
  while (statement.step()) {
    rows.push(
      Object.fromEntries(
        Array.from(Array(columnCount).keys()).map((i) => [
          columnNames[i],
          statement.get(i),
        ]),
      ),
    );
  }
  statement.reset();

  return columnCount > 0 ? { rows } : { ok: true };
}

export type LiveQueryMessage =
  | { ok: true }
  | { rows: unknown[] }
  | { error: string };
const liveQueries: Map<string, { port: MessagePort; status: LiveQueryStatus }> =
  new Map();
type LiveQueryStatus =
  | { kind: "unprepared"; statement: SqlStatement }
  | {
      kind: "prepared";
      tables: string[];
      prepared: PreparedStatement;
      sql: string;
    };
let liveQueriesEnabled = true;

export function disableLiveQueries() {
  liveQueriesEnabled = false;
  db && sqlite3 && sqlite3.capi.sqlite3_set_authorizer(db, null as any, 0);
  authorizerQueue = [];
}
export async function enableLiveQueries() {
  if (!liveQueriesEnabled) {
    for (const id of liveQueries.keys()) {
      await updateLiveQuery(id);
    }
    db && sqlite3 && sqlite3.capi.sqlite3_set_authorizer(db, authorizer, 0);
    liveQueriesEnabled = true;
  }
}

export async function createLiveQuery(
  id: string,
  port: MessagePort,
  statement: SqlStatement,
) {
  liveQueries.set(id, { port, status: { kind: "unprepared", statement } });
  await updateLiveQuery(id);
}

function tablesFromActions(actions: Action[]): string[] {
  const tables = [];
  for (const { actionCode, arg1: tableName } of actions) {
    if (actionCode == "SQLITE_READ" && tableName) {
      tables.push(tableName);
    }
  }
  return tables;
}

async function updateLiveQuery(id: string) {
  const query = liveQueries.get(id);
  if (!query) throw `No Live query with ID: ${id}`;
  const { port, status } = query;
  let preparedStatement: PreparedStatement | undefined;
  if (status.kind == "unprepared") {
    try {
      const { prepared: prepared, actions } = await prepareSql(
        status.statement,
      );
      liveQueries.set(id, {
        port,
        status: {
          kind: "prepared",
          prepared,
          tables: tablesFromActions(actions),
          sql: status.statement.sql,
        },
      });
      preparedStatement = prepared;
    } catch (e: any) {
      port.postMessage({ error: e.toString() } satisfies LiveQueryMessage);
      return;
    }
  } else if (status.kind == "prepared") {
    preparedStatement = status.prepared;
  }

  try {
    if (!preparedStatement) throw "Unreachable";
    const result = runPreparedStatement(preparedStatement);
    port.postMessage(result satisfies LiveQueryMessage);
  } catch (e: any) {
    port.postMessage({ error: e.toString() } satisfies LiveQueryMessage);
  }
}

async function updateLiveQueries(actions: Action[]) {
  if (!liveQueriesEnabled) return;

  for (const [id, { status }] of liveQueries.entries()) {
    // If a query is unprepared it means it failed to prepare when the query was created. In this
    // case we don't know what tables it was realted to so we try to re-prepare it for every query
    // that is made on the database, hoping a schema change will fix it.
    if (status.kind == "unprepared") {
      console.log("update unprepared");
      await updateLiveQuery(id);

      // For prepared statements we are able to check which tables they are involved in.
    } else if (status.kind == "prepared") {
      let foundMatchingUpdate = false;
      for (const action of actions) {
        if (
          (action.actionCode == "SQLITE_INSERT" ||
            action.actionCode == "SQLITE_UPDATE" ||
            action.actionCode == "SQLITE_DELETE" ||
            action.actionCode == "SQLITE_CREATE_TABLE" ||
            action.actionCode == "SQLITE_DROP_TABLE" ||
            action.actionCode == "SQLITE_CREATE_VTABLE" ||
            action.actionCode == "SQLITE_DROP_VTABLE" ||
            action.actionCode == "SQLITE_CREATE_VIEW" ||
            action.actionCode == "SQLITE_DROP_VIEW" ||
            action.actionCode == "SQLITE_ALTER_TABLE") &&
          action.arg1 &&
          status.tables.includes(action.arg1)
        ) {
          foundMatchingUpdate = true;
          break;
        }
      }
      if (!foundMatchingUpdate) continue;
      await updateLiveQuery(id);
    }
  }
}

export function deleteLiveQuery(id: string) {
  liveQueries.delete(id);
}

export async function closeDatabase(): Promise<void> {
  if (db && typeof db.close === "function") {
    try {
      db.close();
    } finally {
      db = null;
    }
  }
}

export type Action = {
  actionCode: ActionType;
  arg1?: string;
  arg2?: string;
  database?: string;
  triggerOrView?: string;
};
export type ActionType = ReturnType<typeof actionCodeName>;
function actionCodeName(actionCode: number) {
  switch (actionCode) {
    case 1:
      return "SQLITE_CREATE_INDEX";
    case 2:
      return "SQLITE_CREATE_TABLE";
    case 3:
      return "SQLITE_CREATE_TEMP_INDEX";
    case 4:
      return "SQLITE_CREATE_TEMP_TABLE";
    case 5:
      return "SQLITE_CREATE_TEMP_TRIGGER";
    case 6:
      return "SQLITE_CREATE_TEMP_VIEW";
    case 7:
      return "SQLITE_CREATE_TRIGGER";
    case 8:
      return "SQLITE_CREATE_VIEW";
    case 9:
      return "SQLITE_DELETE";
    case 10:
      return "SQLITE_DROP_INDEX";
    case 11:
      return "SQLITE_DROP_TABLE";
    case 12:
      return "SQLITE_DROP_TEMP_INDEX";
    case 13:
      return "SQLITE_DROP_TEMP_TABLE";
    case 14:
      return "SQLITE_DROP_TEMP_TRIGGER";
    case 15:
      return "SQLITE_DROP_TEMP_VIEW";
    case 16:
      return "SQLITE_DROP_TRIGGER";
    case 17:
      return "SQLITE_DROP_VIEW";
    case 18:
      return "SQLITE_INSERT";
    case 19:
      return "SQLITE_PRAGMA";
    case 20:
      return "SQLITE_READ";
    case 21:
      return "SQLITE_SELECT";
    case 22:
      return "SQLITE_TRANSACTION";
    case 23:
      return "SQLITE_UPDATE";
    case 24:
      return "SQLITE_ATTACH";
    case 25:
      return "SQLITE_DETACH";
    case 26:
      return "SQLITE_ALTER_TABLE";
    case 27:
      return "SQLITE_REINDEX";
    case 28:
      return "SQLITE_ANALYZE";
    case 29:
      return "SQLITE_CREATE_VTABLE";
    case 30:
      return "SQLITE_DROP_VTABLE";
    case 31:
      return "SQLITE_FUNCTION";
    case 32:
      return "SQLITE_SAVEPOINT";
    case 0:
      return "SQLITE_COPY";
    case 33:
      return "SQLITE_RECURSIVE";
    default:
      throw "Invalid action code";
  }
}
