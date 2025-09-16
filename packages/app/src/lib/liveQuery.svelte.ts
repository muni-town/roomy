import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import { backend } from "./workers";
import type { LiveQueryMessage } from "./setup-sqlite";

export class LiveQuery<Row extends { [key: string]: unknown }> {
  result: Row[] | undefined = $state.raw(undefined);
  error: string | undefined = $state.raw(undefined);

  constructor(
    sql: string | (() => string),
    params?: () => BindingSpec,
    mapper?: (row: any) => Row,
  ) {
    $effect(() => {
      const id = crypto.randomUUID();
      const channel = new MessageChannel();
      channel.port1.onmessage = (ev) => {
        const data: LiveQueryMessage = ev.data;
        if ("error" in data) {
          this.error = data.error;
          console.warn(`Sqlite error in live query (${sql}): ${this.error}`);
        } else if ("rows" in data) {
          this.result = (data as { rows: Row[] }).rows.map(
            mapper || ((x) => x),
          );
        }
      };
      const p = params?.();

      const s = typeof sql == "string" ? sql : sql();

      // Obtain a lock to this query so that the shared worker can know when a live query is
      // no longer needed and it can destroy it.
      let dropLock: () => void = () => {};
      navigator.locks.request(id, async (_lock) => {
        backend.createLiveQuery(id, channel.port2, s, p);
        await new Promise((r) => (dropLock = r as any));
      });

      return () => {
        dropLock();
      };
    });
  }
}
