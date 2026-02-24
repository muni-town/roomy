import { peer } from "$lib/workers";
import type { LiveQueryMessage } from "$lib/workers/sqlite/setup";
import type { SqlStatement } from "$lib/workers/sqlite/types";
import type { AsyncState } from "@roomy/sdk";

/** Simple LRU cache using Map insertion order. */
class LRUCache<K, V> {
  #map = new Map<K, V>();
  #maxSize: number;

  constructor(maxSize: number) {
    this.#maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#maxSize) {
      // Delete oldest (first) entry
      const firstKey = this.#map.keys().next().value!;
      this.#map.delete(firstKey);
    }
  }
}

/** Module-level cache shared across all LiveQuery instances. */
const queryCache = new LRUCache<string, unknown[]>(200);

function cacheKey(stmt: SqlStatement): string {
  return JSON.stringify({ sql: stmt.sql, params: stmt.params });
}

export interface LiveQueryOptions {
  /** Short semantic description of what the query is for */
  description?: string;
  /** File where the query lives, to help find it */
  origin?: string;
  /** Whether to use SWR cache. Default: true */
  cache?: boolean;
}

export class LiveQuery<Row extends { [key: string]: unknown }> {
  current: AsyncState<Row[]> = $state.raw({ status: "loading" });
  #statement: SqlStatement = { sql: "" };

  constructor(
    statement: () => SqlStatement,
    mapper?: (row: any) => Row,
    options?: LiveQueryOptions,
  ) {
    const useCache = options?.cache !== false;
    const mapRow = mapper || ((x: any) => x);

    $effect(() => {
      // Compute the statement. Since we are in an effect this will be re-computed if any
      // dependencies of `statement()` change.
      this.#statement = statement();

      const key = cacheKey(this.#statement);

      // Serve cached data immediately as stale, otherwise reset to loading
      if (useCache) {
        const cached = queryCache.get(key);
        if (cached) {
          // console.debug("[LiveQuery] cache hit", {
          //   ...options,
          //   params: this.#statement.params,
          //   key,
          // });
          this.current = {
            status: "success",
            data: cached as Row[],
            stale: true,
          };
        } else {
          // console.debug("[LiveQuery] cache miss", {
          //   ...options,
          //   params: this.#statement.params,
          //   key,
          // });
          // Reset to loading state when cache misses - this prevents showing stale data
          // from the previous query while waiting for new results
          this.current = { status: "loading" };
        }
      } else {
        // When caching is disabled, always start from loading state
        this.current = { status: "loading" };
      }

      // Create a unique lock ID to use for this query
      const lockId = `live-query-${crypto.randomUUID()}`;

      // Create callback to drop the query when we are finished with it. ( Initialized in the next line. )
      let dropQuery: () => void = () => {};

      // Create a promise that will resolve once the query has been dropped.
      const queryDropped = new Promise((r) => (dropQuery = r as any));

      // Obtain a web-lock for this query that will be held for as long as we are interested in the
      // results of the live query.
      navigator.locks.request(lockId, async () => {
        // Create a new message channel to receive live query results
        const channel = new MessageChannel();

        // When new results come over the channel, we need to parse the message and update the
        // current state.
        channel.port1.onmessage = (ev) => {
          const data: LiveQueryMessage = ev.data;
          if ("error" in data) {
            this.current = { status: "error", message: data.error };
            console.warn(
              `Sqlite error in live query (${this.#statement.sql}): ${data.error}`,
            );
          } else if ("rows" in data) {
            const rows = (data as { rows: Row[] }).rows.map(mapRow);
            if (useCache) {
              queryCache.set(key, rows);
            }
            this.current = { status: "success", data: rows };
          }
        };

        // Register the live query with the peer so that we will get notified when results come
        // in.
        peer.createLiveQuery(lockId, channel.port2, this.#statement);

        // Wait here to hold the web lock until the query is dropped. The peer will try to obtain
        // the query lock that we currently hold, so as soon as we exit this closure, the peer
        // will drop our the query for us.
        await queryDropped;
      });

      // This callback will be called by Svelte before the effect is re-run because of changes, or
      // when the component is unmounted.
      return () => {
        // Drop the query lock, which will alert the peer that it may delete the query.
        dropQuery();
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
