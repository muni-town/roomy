import { messagePortInterface, reactiveWorkerState } from "./workerMessaging";
import backendWorkerUrl from "./backendWorker.ts?worker&url";
import type { BackendInterface, BackendStatus, SqliteStatus } from "./types";

// Force page reload when hot reloading this file to avoid confusion if the workers get mixed up.
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload());
}

/** Reactive status of the shared worker "backend". */
export const backendStatus = reactiveWorkerState<BackendStatus>(
  new BroadcastChannel("backend-status"),
  false,
);
(globalThis as any).backendStatus = backendStatus;

const workerStatusChannel = new MessageChannel();
export const sqliteStatus = reactiveWorkerState<SqliteStatus>(
  workerStatusChannel.port1,
  false,
);

(globalThis as any).sqliteStatus = sqliteStatus;

// Initialize shared worker
export const hasSharedWorker = "SharedWorker" in globalThis;
const hasWorker = "Worker" in globalThis;
const SharedWorkerConstructor = hasSharedWorker
  ? SharedWorker
  : hasWorker
    ? Worker
    : undefined;
if (!SharedWorkerConstructor)
  throw new Error("No SharedWorker or Worker constructor defined");
const backendWorker = new SharedWorkerConstructor(backendWorkerUrl, {
  name: "roomy-backend",
  type: "module",
});

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const backend = messagePortInterface<{}, BackendInterface>(
  "port" in backendWorker ? backendWorker.port : backendWorker,
  {},
);

(globalThis as any).backend = backend;

// Start a sqlite worker for this tab.
const sqliteWorkerChannel = new MessageChannel();
backend.addClient(sqliteWorkerChannel.port1);
const sqliteWorker = new Worker(new URL("./sqliteWorker.ts", import.meta.url), {
  name: "roomy-sqlite-worker",
  type: "module",
});
sqliteWorker.postMessage(
  {
    backendPort: sqliteWorkerChannel.port2,
    statusPort: workerStatusChannel.port2,
  },
  [sqliteWorkerChannel.port2, workerStatusChannel.port2],
);

// for running in console REPL
(window as any).debugWorkers = {
  async pingBackend() {
    try {
      const result = await backend.ping();
      console.log("Main thread: Backend ping result", result);
      return result;
    } catch (error) {
      console.error("Main thread: Backend ping failed", error);
      throw error;
    }
  },

  async testSqliteConnection() {
    try {
      const result = await backend.runQuery({ sql: "SELECT 1 as test" });
      console.log("Main thread: SQLite test query result", result);
      return result;
    } catch (error) {
      console.error("Main thread: SQLite test query failed", error);
      throw error;
    }
  },
};
