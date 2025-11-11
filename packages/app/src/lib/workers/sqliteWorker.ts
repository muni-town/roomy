/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  BackendInterface,
  Savepoint,
  SqliteStatus,
  SqliteWorkerInterface,
} from "./types";
import {
  initializeDatabase,
  executeQuery,
  deleteLiveQuery,
  createLiveQuery,
  disableLiveQueries,
  enableLiveQueries,
  getVfsType,
} from "./setupSqlite";
import { messagePortInterface, reactiveWorkerState } from "./workerMessaging";
import Dexie, { type EntityTable } from "dexie";
import { CONFIG } from "$lib/config";

console.log("Started sqlite worker");

const QUERY_LOCK = "sqliteQueryLock";
const HEARTBEAT_KEY = "sqlite-worker-heartbeat";
const LOCK_TIMEOUT_MS = 8000; // 30 seconds

const workerId = crypto.randomUUID();

interface KeyValue {
  key: string;
  value: string;
}
const db = new Dexie("mini-shared-worker-db") as Dexie & {
  kv: EntityTable<KeyValue, "key">;
  streamCursors: EntityTable<
    { streamId: string; latestEvent: number },
    "streamId"
  >;
};
db.version(1).stores({
  kv: `key`,
  streamCursors: `streamId`,
});

// Add connection health monitoring
let isConnectionHealthy = true;

// Heartbeat mechanism to prove this worker is alive
let heartbeatInterval: NodeJS.Timeout | null = null;

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  heartbeatInterval = setInterval(() => {
    // Store heartbeat with current timestamp
    try {
      db.kv.put({
        key: HEARTBEAT_KEY,
        value: JSON.stringify({
          workerId,
          timestamp: Date.now(),
        }),
      });
    } catch (e) {
      console.warn("SQLite worker: Failed to update heartbeat", e);
    }
  }, 5000); // Update every 5 seconds
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

globalThis.onmessage = (ev) => {
  console.log("SqliteWorker received message", ev);
  const ports: { backendPort: MessagePort; statusPort: MessagePort } = ev.data;

  // Monitor port health
  ports.backendPort.onmessageerror = (error) => {
    console.error("SQLite worker: Backend port message error", error);
    isConnectionHealthy = false;
  };

  ports.statusPort.onmessageerror = (error) => {
    console.error("SQLite worker: Status port message error", error);
    isConnectionHealthy = false;
  };

  const status = reactiveWorkerState<SqliteStatus>(ports.statusPort, true);

  const backend = messagePortInterface<{}, BackendInterface>(
    ports.backendPort,
    {},
  );

  status.workerId = workerId;
  status.isActiveWorker = false; // Initialize to false for reactive state tracking
  status.vfsType = undefined; // Will be set after database initialization
  console.log("SQLite Worker id", workerId);

  function cleanup() {
    console.log("SQLite worker: Cleaning up...");
    stopHeartbeat();
    status.isActiveWorker = false;

    // Clear our heartbeat

    db.kv
      .get(HEARTBEAT_KEY)
      .then((heartbeatData) => {
        if (heartbeatData) {
          const { workerId: storedWorkerId } = JSON.parse(heartbeatData.value);
          if (storedWorkerId === workerId) {
            db.kv.delete(HEARTBEAT_KEY);
          }
        }
      })
      .catch((e) =>
        console.warn("SQLite worker: Failed to clear heartbeat on cleanup", e),
      );
  }

  const callback = async () => {
    console.log("Sqlite worker lock obtained: Active worker id:", workerId);
    status.isActiveWorker = true;
    startHeartbeat();

    globalThis.addEventListener("error", cleanup);
    globalThis.addEventListener("unhandledrejection", cleanup);

    try {
      await initializeDatabase(`/roomy-${CONFIG.moduleVersion}.db`);
      status.vfsType = getVfsType() || undefined;
      console.log("SQLite Worker using VFS:", status.vfsType);

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
        async ping() {
          console.log("SQLite worker: Ping received");

          // Check lock status
          const lockInfo = await navigator.locks.query();
          const sqliteLocks = lockInfo?.held?.filter(
            (lock) =>
              lock.name === "sqlite-worker-lock" || lock.name === QUERY_LOCK,
          );

          if (!isConnectionHealthy) {
            console.warn("SQLite worker: Connection is unhealthy.");
          }
          if (!isConnectionHealthy) {
            console.warn("SQLite worker: Connection is unhealthy.");
          }
          return {
            timestamp: Date.now(),
            workerId,
            isActive: status.isActiveWorker || false,
            locks: sqliteLocks,
            locksPending: lockInfo?.pending?.filter(
              (lock) =>
                lock.name === "sqlite-worker-lock" || lock.name === QUERY_LOCK,
            ),
          };
        },
        runSavepoint,
      });
      backend.setActiveSqliteWorker(sqliteChannel.port2);
      await new Promise(() => {});
    } catch (e) {
      console.error("SQLite worker: Fatal error", e);
      cleanup();
      throw e;
    }
  };

  navigator.locks
    .request(
      "sqlite-worker-lock",
      { mode: "exclusive", signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
      callback,
    )
    .catch(async (error) => {
      if (error.name === "TimeoutError") {
        console.warn("SQLite worker: Lock timeout, attempting steal");
        await attemptLockSteal(callback);
      }
    });
  // status.isActiveWorker = false;
};

async function runSavepoint(savepoint: Savepoint, depth = 0) {
  const exec = async () => {
    await executeQuery({ sql: `savepoint ${savepoint.name}` });
    let hadError = false;
    for (const savepointOrStatement of savepoint.items) {
      try {
        if ("sql" in savepointOrStatement) {
          await executeQuery(savepointOrStatement);
        } else {
          await runSavepoint(savepointOrStatement, depth + 1);
        }
      } catch (e) {
        // Log the error but continue executing other statements
        console.warn(
          `Error executing individual statement in savepoint ${savepoint.name}:`,
          e,
        );
        if (savepointOrStatement && "sql" in savepointOrStatement) {
          console.warn(`Failed SQL:`, savepointOrStatement.sql);
          console.warn(`Failed params:`, savepointOrStatement.params);
        }
        hadError = true;
      }
    }

    if (hadError) {
      console.warn(
        `Savepoint ${savepoint.name} completed with ${hadError ? "errors" : "no errors"}`,
      );
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

async function attemptLockSteal(callback: () => Promise<void>) {
  try {
    // Check if there's a recent heartbeat from another worker
    const heartbeatData = await db.kv.get(HEARTBEAT_KEY);
    if (heartbeatData) {
      const { timestamp, workerId: otherWorkerId } = JSON.parse(
        heartbeatData.value,
      );
      const age = Date.now() - timestamp;

      if (age < LOCK_TIMEOUT_MS && otherWorkerId !== workerId) {
        console.log(
          "SQLite worker: Another active worker detected, backing off",
        );
        return;
      }
    }

    console.log(
      "SQLite worker: No recent heartbeat detected, attempting to acquire lock",
    );

    // Try to acquire lock with ifAvailable first
    const lockAcquired = await navigator.locks.request(
      "sqlite-worker-lock-backup",
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return false;

        console.log("SQLite worker: Successfully stole abandoned lock");
        await callback();
        return true;
      },
    );

    if (!lockAcquired) {
      console.warn(
        "SQLite worker: Could not steal lock, another worker may be active",
      );
    }
  } catch (error) {
    console.error("SQLite worker: Lock steal attempt failed", error);
  }
}
