import {
  QueryClient,
  QueryCache,
  MutationCache,
  type QueryClientConfig,
} from "@tanstack/svelte-query";
import { cache as cacheNs } from "@roomy-space/sdk";
import {
  createCachePersistence,
  IndexedDbPersister,
  LocalStoragePersister,
  type CachePersistence,
  type CachePersister,
  type SnapshotPolicy,
} from "@roomy-space/sdk/browser";
import { scheduleAutoReload } from "$lib/error-recovery";
import { transport } from "@roomy-space/sdk";
import { CONFIG } from "./config";
import { getAppserverOrigin, setAppserverOrigin } from "./appserver-origin";

const { DirectXrpcClient, resolveAppserverHttpOrigin } = transport;
const { persistedShapeVersion, withFallback } = cacheNs;

/**
 * Cached unauthenticated XRPC client. Lazily created on first use, re-used
 * thereafter. Points at the same appserver as the authed client (local-dev
 * override, then the cached DID-resolved origin, then fresh DID resolution).
 */
let unauthXrpc: InstanceType<typeof DirectXrpcClient> | null = null;

/**
 * Get an unauthenticated XRPC client for calling anonymous appserver
 * endpoints — most notably `space.roomy.auth.getLoginScope`, which the app
 * must call *before* the user has a token (to decide which scope to request
 * at login). Returns the cached singleton.
 *
 * Unlike {@link auth.px}, this throws nothing about not being signed in: it
 * is meaningful with or without a session, and never mints a service-auth
 * token (the `DirectXrpcClient` is built with no `serviceAuth`).
 */
export async function pxUnauth(): Promise<
  InstanceType<typeof DirectXrpcClient>
> {
  if (unauthXrpc) return unauthXrpc;
  const appserverUrl =
    CONFIG.appserverHttpOrigin ??
    getAppserverOrigin() ??
    (await resolveAppserverHttpOrigin(CONFIG.appserverDid));
  // Cache the resolved origin so the authed setup path reuses it too.
  setAppserverOrigin(appserverUrl);
  unauthXrpc = new DirectXrpcClient(appserverUrl, CONFIG.appserverDid);
  return unauthXrpc;
}

/**
 * How long a persisted snapshot may be restored: 24 hours, matching the app's
 * existing precedent for this class of state
 * (`scroll-position.svelte.ts`'s 24 h discard window). It is also the
 * `gcTime` below, since an in-memory entry collected before `maxAge` would
 * never reach the next snapshot.
 *
 * This is the persistence plan's `maxAge`, not the wire's: the WebSocket
 * remains the sole freshness authority; this only bounds how old a *restored*
 * value may be before it is discarded rather than shown.
 */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// WS is sole freshness authority — all queries use staleTime: Infinity.
//
// `gcTime` is raised off the 5-minute browser default to the persistence
// window. TanStack's guidance is `gcTime >= maxAge`; with no override an
// unobserved entry is collected after 5 minutes, and the next snapshot save
// then omits it — so a room revisited the next day would restore nothing.
// The six `gcTime: 0` call sites (threads/links/search) keep their opt-out:
// they are collected the moment nothing observes them, and are excluded from
// the persisted set structurally.
//
// The query/mutation cache `onError` callbacks route recoverable ATProto
// session/auth errors (expired/revoked tokens, failed service-auth) to the
// auto-reload recovery in `error-recovery.ts`. Without this, a dead OAuth
// session leaves every query in an error state with no way to recover —
// especially in the PWA, where the page cannot be manually refreshed.
const config: QueryClientConfig = {
  queryCache: new QueryCache({
    onError: (err) => scheduleAutoReload(err),
  }),
  mutationCache: new MutationCache({
    onError: (err) => scheduleAutoReload(err),
  }),
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: CACHE_MAX_AGE_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
};

export const queryClient = new QueryClient(config);

// ── Persistence ──────────────────────────────────────────────────────────
//
// The cache survives a reload: on the unauthenticated → authenticated
// transition the snapshot is restored, invalidated, and kept live by a
// throttled write. The seam and its trust rules live in the SDK
// (`@roomy-space/sdk/cache`, `@roomy-space/sdk/browser`); this is the
// composition point — it owns the `QueryClient`, so it picks the store and
// sequences the restore against auth.
//
// The store is account-scoped and build-scoped: the snapshot carries the DID
// it was written for and the build that wrote it, and a mismatch is discarded
// whole by the SDK. `logout()` clears it before reloading, because the store
// is per-origin, not per-account, and the next sign-in would otherwise
// restore the previous account's rooms.

/**
 * How many entries a snapshot holds. A count cap (not a byte cap) so the cap
 * is deterministic across adaptors; oldest-written entries go first, which is
 * the cheapest proxy for least-recently-visited.
 */
const MAX_PERSISTED_ENTRIES = 200;

/**
 * Cap on how long startup waits for the store. IndexedDB is asynchronous and
 * can be slow to open on a cold profile; a store that never answers must not
 * hold the first paint, so the restore is abandoned at this bound and the app
 * proceeds cold. The abandoned read is harmless — a late `hydrate` cannot
 * overwrite a newer entry.
 */
const RESTORE_TIMEOUT_MS = 1_000;

/** The persistence installed for the current session, used by flush/logout. */
let session: CachePersistence | undefined;

/** A storage failure is diagnostic output, never an application error. */
function report(message: string, detail?: unknown): void {
  if (detail === undefined) console.warn(message);
  else console.warn(message, detail);
}

/**
 * Build the persister for one account.
 *
 * IndexedDB is the web default; `localStorage` is the fallback for a platform
 * where it is absent or has failed (the plan's iOS/Tauri note), and
 * `withFallback` demotes a working IndexedDB to it the first time a read
 * throws — e.g. a corrupted or quota-evicted database. The demotion is the
 * SDK's rule, not this module's.
 */
function choosePersister(policy: SnapshotPolicy): CachePersister {
  const budget = { maxEntries: MAX_PERSISTED_ENTRIES };
  const indexedDb = new IndexedDbPersister({ policy, budget });
  const localStorage = new LocalStoragePersister({ policy, budget });

  if (!indexedDb.available) {
    report("cache: IndexedDB unavailable; using localStorage");
    return localStorage;
  }
  return withFallback(indexedDb, localStorage, report);
}

/**
 * Restore the persisted cache for `accountDid`, then begin writing it.
 *
 * Called on the unauthenticated → authenticated transition, before `startSync`
 * so the restored cache is in place before any WebSocket frame can patch it.
 * Never throws: an unreadable or empty store leaves the cache cold, exactly as
 * the app behaves with no persistence at all.
 */
export async function restoreCache(accountDid: string): Promise<void> {
  if (session) return;

  const policy: SnapshotPolicy = {
    version: persistedShapeVersion(__BUILD_ID__),
    account: accountDid,
    maxAgeMs: CACHE_MAX_AGE_MS,
    onDiagnostic: report,
  };

  const persistence = createCachePersistence({
    queryClient,
    persister: choosePersister(policy),
    onDiagnostic: report,
  });

  // `restore()` never rejects, but a store that never answers would hang
  // startup; race it and proceed cold on timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    persistence.restore(),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        report("cache: restore timed out; starting cold");
        resolve();
      }, RESTORE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);

  persistence.start();
  installFlushHooks(persistence);
  session = persistence;
}

/** Drop the persisted set. Called on logout, before the page reloads. */
export async function clearPersistedCache(): Promise<void> {
  await session?.clear();
  session = undefined;
}

let hooksInstalled = false;

/**
 * The final flush. A backgrounded or closing tab must not lose the last write
 * window: the write throttle can be mid-flight when the page goes away, and
 * `beforeunload` is the only reliable place to catch a close.
 */
function installFlushHooks(persistence: CachePersistence): void {
  if (hooksInstalled || typeof document === "undefined") return;
  hooksInstalled = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void persistence.flush();
  });
  window.addEventListener("beforeunload", () => {
    void persistence.flush();
  });
}
