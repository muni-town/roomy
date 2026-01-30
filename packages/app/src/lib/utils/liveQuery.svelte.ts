import { backend } from "$lib/workers";
import type { LiveQueryMessage } from "$lib/workers/sqlite/setup";
import type { SqlStatement } from "$lib/workers/sqlite/types";
import { locksEnabled, requestLock } from "$lib/workers/locks";
import type { AsyncState } from "@roomy/sdk";

export class LiveQuery<Row extends { [key: string]: unknown }> {
  current: AsyncState<Row[]> = $state.raw({ status: "loading" });
  #statement: SqlStatement = { sql: "" };

  constructor(statement: () => SqlStatement, mapper?: (row: any) => Row) {
    const instanceId = "live-query-instance-" + crypto.randomUUID();

    $effect(() => {
      const id = `live-query-${crypto.randomUUID()}`;
      let dropLock: () => void = () => {};
      const lockPromise = new Promise((r) => (dropLock = r as any));

      this.#statement = statement();

      const setupQuery = async () => {
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

        if (locksEnabled()) {
          // With SharedWorker: use locks to signal when query is no longer in use
          requestLock(id, async () => {
            backend.createLiveQuery(id, channel.port2, this.#statement);
            await lockPromise;
          });
        } else {
          // Without SharedWorker: create query directly, cleanup via effect return
          backend.createLiveQuery(id, channel.port2, this.#statement);
        }
      };

      if (locksEnabled()) {
        requestLock(instanceId, setupQuery);
      } else {
        setupQuery();
      }

      return () => {
        dropLock();
        // When locks are disabled, explicitly delete the live query on cleanup
        if (!locksEnabled()) {
          backend.deleteLiveQuery(id).catch(() => {
            // Ignore errors during cleanup - worker may already be gone
          });
        }
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
