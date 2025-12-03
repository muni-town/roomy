import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import type { Batch, TaskPriority } from "../types";
import type { QueryResult } from "./setup";
import type { Did } from "@atproto/api";

export interface SqliteStatus {
  isActiveWorker: boolean;
  authenticated: string;
  workerId: string;
  vfsType: string;
}

export type SqliteWorkerInterface = {
  authenticate(did: Did): Promise<void>;
  materializeBatch(
    events: Batch.Event,
    priority: TaskPriority,
  ): Promise<Batch.Statement | Batch.ApplyResult>;
  runQuery<Row>(statement: SqlStatement): Promise<QueryResult<Row>>;
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  deleteLiveQuery(id: string): Promise<void>;
  ping(): Promise<{ timestamp: number; workerId: string; isActive: boolean }>;
  runSavepoint(savepoint: Savepoint): Promise<QueryResult[]>;
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
