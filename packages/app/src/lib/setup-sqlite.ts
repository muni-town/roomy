import initSqlite3, {
  type Database,
  type OpfsSAHPoolDatabase,
  type BindingSpec,
  type Sqlite3Static,
  type PreparedStatement,
} from "@sqlite.org/sqlite-wasm";

let sqlite3: Sqlite3Static | null = null;
let db: OpfsSAHPoolDatabase | Database | null = null;
let initPromise: Promise<void> | null = null;

export function isDatabaseReady(): boolean {
  return !!db;
}

/** This is a queue of all operations recorded by our global sqlite authorizer */
let authorizerQueue: Action[] = [];

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
    // Retry a few times because SAH Pool can transiently fail during context handoff
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const pool = await sqlite3.installOpfsSAHPoolVfs({});
        db = new pool.OpfsSAHPoolDb(dbName);
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
    if (!db) throw lastErr ?? new Error("sahpool_init_failed");

    // Set an authorizer function that will allow us to track reads and writes to the database
    sqlite3.capi.sqlite3_set_authorizer(
      db,
      (_arg, actionCode, arg1, arg2, database, triggerOrView) => {
        authorizerQueue.push({
          actionCode: actionCodeName(actionCode),
          arg1: arg1 || undefined,
          arg2: arg2 || undefined,
          database: database || undefined,
          triggerOrView: triggerOrView || undefined,
        });
        return 0;
      },
      0,
    );
    db.exec("pragma locking_mode = exclusive;");
    db.exec("pragma journal_mode = wal");
  })();
  await initPromise;
}

export async function executeQuery(
  sql: string,
  params?: BindingSpec,
): Promise<
  ({ rows: { [key: string]: unknown }[] } | { ok: true }) & {
    actions: Action[];
  }
> {
  if (!db && initPromise) await initPromise;
  if (!db || !sqlite3) throw new Error("database_not_initialized");

  try {
    const { statement, actions } = await prepareSql(sql, params);
    const result = runPreparedStatement(statement);

    // Update live queries asynchronously
    updateLiveQueries(actions);

    return { ...result, actions };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message);
  }
}

async function prepareSql(
  sql: string,
  params?: BindingSpec,
): Promise<{ statement: PreparedStatement; actions: Action[] }> {
  if (!db && initPromise) await initPromise;
  if (!db || !sqlite3) throw new Error("database_not_initialized");

  authorizerQueue = [];
  const statement = db.prepare(sql);
  if (params) statement.bind(params);
  const actions = [...authorizerQueue];
  return { statement: statement, actions };
}

function runPreparedStatement(
  statement: PreparedStatement,
): { ok: true } | { rows: { [key: string]: unknown }[] } {
  const rows = [];
  const columnCount = statement.columnCount;
  const columnNames = [
    ...Array(columnCount)
      .keys()
      .map((x) => statement.getColumnName(x)),
  ];
  while (statement.step()) {
    rows.push(
      Object.fromEntries(
        Array(columnCount)
          .keys()
          .map((i) => [columnNames[i], statement.get(i)]),
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
const liveQueries: Map<
  string,
  { port: MessagePort; tables: string[]; statement: PreparedStatement }
> = new Map();

// FIXME: we need to make sure that this registers the live query even if the SQL statement fails to
// prepare.
export async function createLiveQuery(
  id: string,
  port: MessagePort,
  sql: string,
  params?: BindingSpec,
) {
  try {
    const { statement, actions } = await prepareSql(sql, params);
    const tables = [];
    for (const { actionCode, arg1: tableName } of actions) {
      if (actionCode == "SQLITE_READ" && tableName) {
        tables.push(tableName);
      }
    }
    liveQueries.set(id, { port, tables, statement });
    const result = runPreparedStatement(statement);
    port.postMessage(result satisfies LiveQueryMessage);
  } catch (e: any) {
    port.postMessage({ error: e.toString() } satisfies LiveQueryMessage);
  }
}

async function updateLiveQueries(actions: Action[]) {
  for (const { port, tables, statement } of liveQueries.values()) {
    let foundMatchingUpdate = false;
    for (const action of actions) {
      if (
        (action.actionCode == "SQLITE_INSERT" ||
          action.actionCode == "SQLITE_UPDATE" ||
          action.actionCode == "SQLITE_DELETE") &&
        action.arg1 &&
        tables.includes(action.arg1)
      ) {
        foundMatchingUpdate = true;
        break;
      }
    }
    if (!foundMatchingUpdate) continue;
    const result = runPreparedStatement(statement);
    port.postMessage(result);
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
