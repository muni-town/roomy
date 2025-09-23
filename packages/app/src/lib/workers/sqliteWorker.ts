/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  BackendInterface,
  Savepoint,
  SqliteStatus,
  SqliteWorkerInterface,
} from "./index";
import {
  initializeDatabase,
  executeQuery,
  deleteLiveQuery,
  createLiveQuery,
  disableLiveQueries,
  enableLiveQueries,
} from "./setupSqlite";
import { messagePortInterface, reactiveWorkerState } from "./workerMessaging";

const QUERY_LOCK = "sqliteQueryLock";

globalThis.onmessage = (ev) => {
  console.log("Started sqlite worker");
  const ports: { backendPort: MessagePort; statusPort: MessagePort } = ev.data;

  const status = reactiveWorkerState<SqliteStatus>(ports.statusPort, true);

  const backend = messagePortInterface<{}, BackendInterface>(
    ports.backendPort,
    {},
  );

  navigator.locks.request(
    "sqlite-worker-lock",
    { mode: "exclusive" },
    async () => {
      console.log(
        "Sqlite worker lock obtained: I'm now the active sqlite worker.",
      );
      status.isActiveWorker = true;
      await initializeDatabase("/mini.db");

      const sqliteChannel = new MessageChannel();
      messagePortInterface<SqliteWorkerInterface, {}>(sqliteChannel.port1, {
        async runQuery(statement) {
          // This lock makes sure that the JS tasks don't interleave some other query executions in while we
          // are trying to compose a bulk transaction.
          return navigator.locks.request(QUERY_LOCK, async () => {
            try {
              return await executeQuery(statement);
            } catch (e) {
              throw new Error(
                `Error running SQL query \`${statement.sql}\`: ${e}`,
              );
            }
          });
        },
        async createLiveQuery(id, port, statement) {
          createLiveQuery(id, port, statement);
        },
        async deleteLiveQuery(id) {
          deleteLiveQuery(id);
        },
        runSavepoint,
      });
      backend.setActiveSqliteWorker(sqliteChannel.port2);
      await new Promise(() => {});
    },
  );
  status.isActiveWorker = false;
};

async function runSavepoint(savepoint: Savepoint, depth = 0) {
  const exec = async () => {
    await executeQuery({ sql: `savepoint ${savepoint.name}` });
    try {
      for (const savepointOrStatement of savepoint.items) {
        if ("sql" in savepointOrStatement) {
          await executeQuery(savepointOrStatement);
        } else {
          await runSavepoint(savepointOrStatement, depth + 1);
        }
      }
    } catch (e) {
      console.error("Error executing savepoint", e);
      await executeQuery({ sql: `rollback to ${savepoint.name}` });
    }
    await executeQuery({ sql: `release ${savepoint.name}` });
  };

  if (depth == 0) {
    console.log("runSavepoint", savepoint);
    disableLiveQueries();

    // This lock makes sure that the JS tasks don't interleave some other query executions in while we
    // are trying to compose a bulk transaction.
    const result = await navigator.locks.request(QUERY_LOCK, exec);

    await enableLiveQueries();
    return result;
  } else {
    return exec();
  }
}
