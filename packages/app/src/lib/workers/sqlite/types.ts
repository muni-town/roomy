import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import type { Batch, TaskPriority } from "../types";
import type { QueryResult } from "./setup";
import type { StreamDid } from "@roomy/sdk";

export interface SqliteStatus {
  isActiveWorker: boolean;
  workerId: string;
  vfsType: string;
}

export type SqliteWorkerInterface = {
  materializeBatch(
    events: Batch.Events,
    priority: TaskPriority,
  ): Promise<Batch.Statement | Batch.ApplyResult>;
  runQuery<Row>(statement: SqlStatement): Promise<QueryResult<Row>>;
  resetLocalDatabase(): Promise<
    { done: true } | { done: false; error: string }
  >;
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  deleteLiveQuery(id: string): Promise<void>;
  ping(): Promise<{ timestamp: number; workerId: string; isActive: boolean }>;
  runSavepoint(savepoint: Savepoint): Promise<QueryResult[]>;
  /** Connect to all spaces accumulated during personal stream backfill.
   * This should be called after the personal stream is fully materialized
   * to ensure we don't connect to spaces the user has left. */
  connectPendingSpaces(currentSpaceId: StreamDid): Promise<void>;
};

export interface SqlStatement {
  sql: string;
  params?: BindingSpec;
  /** If this is true, the query will not be pre-compiled and cached. Use this when you have to
   * substitute strings into the sql query instead of using params, because that will mess up the
   * cache which must be indexed by the SQL. */
  cache?: boolean;
}

export interface Savepoint {
  name: string;
  items: (SqlStatement | Savepoint)[];
}
