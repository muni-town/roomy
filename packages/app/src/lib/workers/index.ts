import { messagePortInterface, reactiveWorkerState } from "./workerMessaging";
import backendWorkerUrl from "./backendWorker.ts?worker&url";
import type {
  BackendInterface,
  BackendStatus,
  ConsoleInterface,
  SqliteStatus,
} from "./types";

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
export const backend = messagePortInterface<ConsoleInterface, BackendInterface>(
  "port" in backendWorker ? backendWorker.port : backendWorker,
  {
    async log(level, args) {
      const prefixedArgs = ["[SharedWorker]", ...args];
      console[level](...prefixedArgs);
    },
  },
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
