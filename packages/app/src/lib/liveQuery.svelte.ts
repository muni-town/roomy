import { backend } from "./workers";
import type { LiveQueryMessage } from "./workers/setupSqlite";
import type { SqlStatement } from "./workers/backendWorker";

export class LiveQuery<Row extends { [key: string]: unknown }> {
  result: Row[] | undefined = $state.raw(undefined);
  error: string | undefined = $state.raw(undefined);
  #statement: SqlStatement = { sql: "" };

  constructor(statement: () => SqlStatement, mapper?: (row: any) => Row) {
    $effect(() => {
      const id = crypto.randomUUID();
      const channel = new MessageChannel();
      channel.port1.onmessage = (ev) => {
        const data: LiveQueryMessage = ev.data;
        if ("error" in data) {
          this.error = data.error;
          console.warn(
            `Sqlite error in live query (${this.#statement.sql}): ${this.error}`,
          );
        } else if ("rows" in data) {
          this.result = (data as { rows: Row[] }).rows.map(
            mapper || ((x) => x),
          );
          this.error = undefined;
        }
      };

      this.#statement = statement();

      // Obtain a lock to this query so that the shared worker can know when a live query is
      // no longer needed and it can destroy it.
      let dropLock: () => void = () => {};
      navigator.locks.request(id, async (_lock) => {
        backend.createLiveQuery(id, channel.port2, this.#statement);
        await new Promise((r) => (dropLock = r as any));
      });

      return () => {
        dropLock();
      };
    });
  }
}
