/**
 * Compose a {@link CachePersister} with a TanStack {@link QueryClient}: the
 * restore-on-load path, the throttled write schedule, and the final flush.
 *
 * Lives under `browser/` because it imports `@tanstack/query-core`; the seam
 * itself (`cache/`) stays framework-agnostic. `client.ts` is the composition
 * point — it owns the `QueryClient` and picks the persister.
 *
 * Three properties this module is built around:
 *
 *   - **A hydrated entry is not stale.** Under `staleTime: Infinity` (the
 *     app's setting; the WebSocket is the sole freshness authority) a restored
 *     entry reports `isStaleByTime(Infinity) === false`, so a mount would
 *     never refetch it and the restored view would never reconcile. The
 *     restore therefore invalidates every key it hydrated with
 *     `refetchType: "none"` — marking it stale *without* starting a fetch, so
 *     a query the user never looks at costs nothing, while the one they do
 *     look at refetches on mount. Measured: after this invalidation a real
 *     observer refetches exactly once (`persistence.test.ts`).
 *
 *   - **The save is off the diff-frame path.** The cache changes on every
 *     `#messageDiff` frame, so a save per change would put a disk write on the
 *     frame path. The write is debounced: the cache subscription only marks
 *     the set dirty, and a trailing timer (or an explicit flush) does the
 *     write.
 *
 *   - **`hydrate` is the right entry point, not `setQueryData`.** It installs
 *     the entry as data-bearing and idle, and only overwrites an existing
 *     entry when the snapshot is newer, so a restore racing an in-flight fetch
 *     cannot lose whichever resolved last.
 */
import {
  hashKey,
  hydrate,
  type QueryClient,
  type QueryKey,
  type QueryState,
} from "@tanstack/query-core";
import {
  isPersistableQuery,
  selectPersistableEntries,
  type CachePersister,
  type Diagnostic,
  type PersistedEntry,
} from "../cache/persister";
import { validateRestoredEntries } from "../cache/restore";

/** How often a dirty cache is written. Long enough to be off the frame path. */
export const DEFAULT_SAVE_THROTTLE_MS = 5_000;

export interface CreateCachePersistenceOptions {
  queryClient: QueryClient;
  persister: CachePersister;
  /** Debounce window for the write, ms. */
  throttleMs?: number;
  onDiagnostic?: Diagnostic;
}

export interface CachePersistence {
  /**
   * Load, validate and hydrate the snapshot. Returns the keys that were
   * restored, so a caller can assert the restore happened. Never throws: an
   * unreadable store yields `[]` and the app fetches as it does on a cold
   * load.
   */
  restore(): Promise<QueryKey[]>;
  /** Begin watching the cache and writing it, throttled. */
  start(): void;
  /** Stop watching. Does not flush. */
  stop(): void;
  /** Write now, if the cache is dirty. Used on `visibilitychange`/`beforeunload`. */
  flush(): Promise<void>;
  /** Drop the persisted set (logout). */
  clear(): Promise<void>;
}

/** A full `QueryState` wrapping a restored value, for `hydrate` to install. */
function restoredQueryState(data: unknown, at: number): QueryState {
  return {
    data,
    dataUpdatedAt: at,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    status: "success",
    fetchStatus: "idle",
    dataUpdateCount: 1,
  };
}

export function createCachePersistence(
  opts: CreateCachePersistenceOptions,
): CachePersistence {
  const { queryClient, persister } = opts;
  const diag = opts.onDiagnostic;
  const throttleMs = opts.throttleMs ?? DEFAULT_SAVE_THROTTLE_MS;

  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  function persistable(): PersistedEntry[] {
    return selectPersistableEntries(
      queryClient.getQueryCache().getAll().map((query) => ({
        queryKey: query.queryKey,
        state: query.state,
        gcTime: query.options?.gcTime,
      })),
    );
  }

  async function writeNow(): Promise<void> {
    dirty = false;
    await persister.save(persistable());
  }

  function scheduleSave(): void {
    dirty = true;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (dirty) void writeNow();
    }, throttleMs);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    async restore(): Promise<QueryKey[]> {
      let loaded: PersistedEntry[];
      try {
        loaded = await persister.load();
      } catch (err) {
        // Rule 1 at the composition boundary too: a store that violates the
        // never-throws rule must still degrade to an empty cache, not to a
        // failed boot.
        diag?.("cache: persister load failed", err);
        return [];
      }

      const restored = validateRestoredEntries(loaded, diag);
      // `QueryState` so `hydrate` installs a complete, idle entry.
      hydrate(queryClient, {
        mutations: [],
        queries: restored.map((entry) => ({
          queryKey: entry.key,
          queryHash: hashKey(entry.key),
          state: restoredQueryState(entry.state, entry.at),
          dehydratedAt: entry.at,
        })),
      });

      // The load-bearing step: a hydrated entry is NOT stale under
      // `staleTime: Infinity`, so without this a mount would serve it forever.
      // `refetchType: "none"` (a filter, not an option) marks each restored
      // key stale without fetching it — only a query the user actually mounts
      // refetches.
      for (const entry of restored) {
        queryClient.invalidateQueries({
          queryKey: entry.key as unknown[],
          refetchType: "none",
        });
      }

      return restored.map((entry) => entry.key);
    },

    start(): void {
      unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        // `added`/`updated` are the events whose data is worth persisting;
        // observer events and `removed` do not change the persistable set.
        if (event.type !== "added" && event.type !== "updated") return;
        if (
          isPersistableQuery({
            queryKey: event.query.queryKey,
            state: event.query.state,
            gcTime: event.query.options?.gcTime,
          })
        ) {
          scheduleSave();
        }
      });
    },

    stop(): void {
      unsubscribe?.();
      unsubscribe = undefined;
    },

    async flush(): Promise<void> {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (dirty) await writeNow();
    },

    async clear(): Promise<void> {
      dirty = false;
      await persister.clear();
    },
  };
}
