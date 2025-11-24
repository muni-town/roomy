import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import type { Batch } from "../types";
import type { QueryResult } from "./setup";

export interface SqliteStatus {
  isActiveWorker: boolean;
  workerId: string;
  vfsType: string;
}

export type SqliteWorkerInterface = {
  materializeBatch(
    events: Batch.Event,
    priority: "normal" | "background",
  ): Promise<Batch.Statement | Batch.ApplyResult>;
  runQuery<Row>(statement: SqlStatement): Promise<QueryResult<Row>>;
  createLiveQuery(
    id: string,
    port: MessagePort,
    statement: SqlStatement,
  ): Promise<void>;
  deleteLiveQuery(id: string): Promise<void>;
  ping(): Promise<{ timestamp: number; workerId: string; isActive: boolean }>;
  runSavepoint(savepoint: Savepoint): Promise<void>;
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
