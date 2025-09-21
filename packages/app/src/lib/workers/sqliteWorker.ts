/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  BackendInterface,
  SqliteStatus,
  SqliteWorkerInterface,
} from "./index";
import {
  initializeDatabase,
  executeQuery,
  deleteLiveQuery,
  createLiveQuery,
} from "./setupSqlite";
import { messagePortInterface, reactiveWorkerState } from "./workerMessaging";

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
          try {
            return await executeQuery(statement);
          } catch (e) {
            throw new Error(`Error running SQL query \`${statement.sql}\`: ${e}`);
          }
        },
        async createLiveQuery(id, port, statement) {
          createLiveQuery(id, port, statement);
        },
        async deleteLiveQuery(id) {
          deleteLiveQuery(id);
        },
      });
      backend.setActiveSqliteWorker(sqliteChannel.port2);
      await new Promise(() => {});
    },
  );
  status.isActiveWorker = false;
};
