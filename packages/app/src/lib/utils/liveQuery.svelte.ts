import { backend } from "$lib/workers";
import type { LiveQueryMessage } from "$lib/workers/sqlite/setup";
import type { SqlStatement } from "$lib/workers/sqlite/types";

interface LiveQueryLoadingState {
  status: "loading";
}

interface LiveQueryErrorState {
  status: "error";
  message: string;
}

interface LiveQuerySuccessState<T> {
  status: "success";
  data: T;
}

export type LiveQueryState<T> =
  | LiveQueryLoadingState
  | LiveQueryErrorState
  | LiveQuerySuccessState<T>;

export class LiveQuery<Row extends { [key: string]: unknown }> {
  current: LiveQueryState<Row[]> = $state.raw({ status: "loading" });
  #statement: SqlStatement = { sql: "" };

  constructor(statement: () => SqlStatement, mapper?: (row: any) => Row) {
    const instanceId = "live-query-instance-" + crypto.randomUUID();

    $effect(() => {
      const id = `live-query-${crypto.randomUUID()}`;
      let dropLock: () => void = () => {};
      const lockPromise = new Promise((r) => (dropLock = r as any));

      this.#statement = statement();

      navigator.locks.request(instanceId, async () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (ev) => {
          const data: LiveQueryMessage = ev.data;
          if ("error" in data) {
            this.current = { status: "error", message: data.error };
            console.warn(
              `Sqlite error in live query (${this.#statement.sql}): ${data.error}`,
            );
          } else if ("rows" in data) {
            this.current = {
              status: "success",
              data: (data as { rows: Row[] }).rows.map(mapper || ((x) => x)),
            };
          }
        };

        navigator.locks.request(id, async (_lock) => {
          backend.createLiveQuery(id, channel.port2, this.#statement);
          await lockPromise;
        });
      });

      return () => {
        dropLock();
      };
    });
  }

  get result(): Row[] | undefined {
    if (this.current.status === "success") {
      return this.current.data;
    }
    return undefined;
  }

  get error(): string | undefined {
    if (this.current.status === "error") {
      return this.current.message;
    }
    return undefined;
  }
}
