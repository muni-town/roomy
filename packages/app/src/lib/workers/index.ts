import { messagePortInterface, reactiveWorkerState } from "./workerMessaging";
import backendWorkerUrl from "./backend/worker.ts?worker&url";
import type {
  BackendInterface,
  BackendStatus,
  ConsoleInterface,
} from "./backend/types";
import type { SqliteStatus } from "./sqlite/types";
import { CONFIG } from "../config";

// Force page reload when hot reloading this file to avoid confusion if the workers get mixed up.
if (import.meta.hot && !(window as any).__playwright) {
  import.meta.hot.accept(() => window.location.reload());
}

/** Reactive status of the shared worker "backend". */
export const backendStatus = reactiveWorkerState<BackendStatus>(
  new BroadcastChannel("backend-status"),
  false,
);
(globalThis as any).backendStatus = backendStatus;

const workerStatusChannel = new MessageChannel();

/** Reactive status of the sqlite worker for this tab. */
export const sqliteStatus = reactiveWorkerState<SqliteStatus>(
  workerStatusChannel.port1,
  false,
);

(globalThis as any).sqliteStatus = sqliteStatus;

// console.log(
//   "Main thread: sqliteStatus created, workerId:",
//   sqliteStatus.workerId,
// );

// // Add a manual check
// setInterval(() => {
//   console.log("Main thread: Current sqliteStatus =", {
//     workerId: sqliteStatus.workerId,
//     isActive: sqliteStatus.isActiveWorker,
//     vfsType: sqliteStatus.vfsType,
//   });
// }, 10000);

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
      const prefixedArgs = ["[BW]", ...args]; // Backend Worker
      console[level](...prefixedArgs);
    },
  },
);

faro.api.setSession({
  id: await backend.getSessionId(),
  attributes: { isSampled: "true" },
});

(globalThis as any).backend = backend;
(globalThis as any).CONFIG = CONFIG;

console.debug("(init.1) Backend worker loaded");

// Start a sqlite worker for this tab.
const sqliteWorkerChannel = new MessageChannel();
backend.addClient(sqliteWorkerChannel.port1);
const sqliteWorker = new Worker(
  new URL("./sqlite/worker.ts", import.meta.url),
  {
    name: "roomy-sqlite-worker",
    type: "module",
  },
);

console.debug("(init.2) Sqlite worker loaded");

sqliteWorker.postMessage(
  {
    backendPort: sqliteWorkerChannel.port2,
    statusPort: workerStatusChannel.port2,
    dbName: "temp",
    sessionId: faro.api.getSession()!.id,
  },
  [sqliteWorkerChannel.port2, workerStatusChannel.port2],
);

export function getPersonalStreamId() {
  return backendStatus.authState?.state === "authenticated"
    ? backendStatus.authState.personalStream
    : undefined;
}

// for running in console REPL
(window as any).debugWorkers = {
  async enableLogForwarding() {
    await backend.enableLogForwarding();
  },

  async disableLogForwarding() {
    await backend.disableLogForwarding();
  },

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

  logWorkerStatus() {
    console.log("📊 [backendStatus] Current state:", backendStatus.current);
    console.log("🗃️ [sqliteStatus] Current state:", sqliteStatus.current);
  },

  async diagnoseRoom(roomId: string) {
    const { sql } = await import("../utils/sqlTemplate");
    try {
      const diagnosticQuery = sql`
        select json_object(
          'roomId', ${roomId},
          'existsInEntities', case when e.id is not null then 1 else 0 end,
          'streamId', e.stream_id,
          'parent', e.parent,
          'hasCompRoom', case when r.entity is not null then 1 else 0 end,
          'roomLabel', r.label,
          'roomDeleted', r.deleted,
          'hasCompInfo', case when i.entity is not null then 1 else 0 end,
          'roomName', i.name,
          'parentExists', case when parent_e.id is not null then 1 else 0 end,
          'parentDeleted', parent_r.deleted,
          'parentLabel', parent_r.label,
          'parentName', parent_i.name,
          'parentStreamId', parent_e.stream_id,
          'parentHasCompRoom', case when parent_r.entity is not null then 1 else 0 end,
          'parentHasCompInfo', case when parent_i.entity is not null then 1 else 0 end,
          'wouldAppearInSidebar', case 
            when e.id is null then 'NO: Room does not exist in entities'
            when r.entity is null then 'NO: Missing comp_room entry'
            when i.entity is null then 'NO: Missing comp_info entry'
            when r.deleted = 1 then 'NO: Room is deleted'
            when e.parent is not null and (parent_r.entity is null or parent_r.deleted = 1) then 'MAYBE: Parent is deleted (should show as orphaned)'
            when e.parent is null then 'YES: Top-level room'
            when parent_r.entity is not null and parent_r.deleted = 0 then 'YES: Child of valid parent'
            else 'UNKNOWN'
          end
        ) as diagnostic
        from (select ${roomId} as room_id)
        left join entities e on e.id = ${roomId}
        left join comp_room r on r.entity = ${roomId}
        left join comp_info i on i.entity = ${roomId}
        left join entities parent_e on parent_e.id = e.parent
        left join comp_room parent_r on parent_r.entity = e.parent
        left join comp_info parent_i on parent_i.entity = e.parent
      `;

      const result = await backend.runQuery(diagnosticQuery);
      const diagnostic = result.rows?.[0]
        ? JSON.parse((result.rows[0] as any).diagnostic as string)
        : null;

      console.log("🔍 Room Diagnostic for", roomId + ":", diagnostic);

      // Also check if parent would appear in sidebar
      if (diagnostic?.parent) {
        const parentDiagnostic = await this.diagnoseRoom(diagnostic.parent);
        console.log("🔍 Parent Category Diagnostic:", parentDiagnostic);
        diagnostic.parentDiagnostic = parentDiagnostic;
      }

      return diagnostic;
    } catch (error) {
      console.error("Main thread: Room diagnostic failed", error);
      throw error;
    }
  },

  async diagnosesidebar(spaceId?: string) {
    try {
      const { current } = await import("../queries");
      const { sql } = await import("../utils/sqlTemplate");

      const actualSpaceId = spaceId || current.joinedSpace?.id;

      if (!actualSpaceId) {
        console.log("❌ No space ID available");
        return { error: "No space ID available" };
      }

      const encodedSpaceId = actualSpaceId;

      const diagnosticQuery = sql`
        select json_object(
          'spaceId', '${actualSpaceId}',
          'currentSpaceId', '${current.joinedSpace?.id}',
          'totalRooms', (select count(*) from entities e join comp_room r on r.entity = e.id where e.stream_id = ${encodedSpaceId}),
          'topLevelRooms', (select count(*) from entities e join comp_room r on r.entity = e.id join comp_info i on i.entity = e.id where e.stream_id = ${encodedSpaceId} and e.parent is null and (r.deleted = 0 or r.deleted is null)),
          'categories', (select count(*) from entities e join comp_room r on r.entity = e.id join comp_info i on i.entity = e.id where e.stream_id = ${encodedSpaceId} and r.label = 'category' and (r.deleted = 0 or r.deleted is null)),
          'channels', (select count(*) from entities e join comp_room r on r.entity = e.id join comp_info i on i.entity = e.id where e.stream_id = ${encodedSpaceId} and r.label = 'channel' and (r.deleted = 0 or r.deleted is null)),
          'roomsWithStreamId0ace', (select count(*) from entities e join comp_room r on r.entity = e.id where hex(e.stream_id) = '0ace'),
          'sampleRoomStreamIds', (select json_group_array(id(e.stream_id)) from entities e join comp_room r on r.entity = e.id limit 5)
        ) as diagnostic
      `;

      const result = await backend.runQuery(diagnosticQuery);
      const diagnostic = result.rows?.[0]
        ? JSON.parse((result.rows[0] as any).diagnostic as string)
        : null;

      console.log("🔍 Sidebar Diagnostic:", diagnostic);
      console.log("📊 Current space from queries:", current.joinedSpace);
      return diagnostic;
    } catch (error) {
      console.error("Main thread: Sidebar diagnostic failed", error);
      throw error;
    }
  },
};
