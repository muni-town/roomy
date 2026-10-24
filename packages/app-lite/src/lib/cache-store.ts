/**
 * Where the cache is persisted, per platform.
 *
 * The seam (`@roomy-space/sdk/cache`) decides *what* may be trusted; this module
 * decides *where the bytes go*, and it is the only place that decides it.
 * `client.ts` composes with the answer, so the web and the shell share one
 * restore path and one write schedule.
 *
 * The rule, and why it is not merely a preference:
 *
 *   - **Shell → the native store.** A Tauri shell's store is a JSON file in the
 *     app's data directory, outside the webview entirely. That matters most on
 *     iOS, where the webview's IndexedDB is reported to misbehave under Tauri;
 *     the native store is the default there for that reason.
 *   - **Shell with no native store → `localStorage`.** Not IndexedDB: the reason
 *     the shell prefers the native store is the webview's IndexedDB, so falling
 *     back to it would be falling back to the thing being avoided.
 *   - **Web → IndexedDB, then `localStorage`.** The web default, unchanged:
 *     IndexedDB is asynchronous and roomy, `localStorage` is the always-present
 *     fallback, and the seam demotes between them on the first failed read.
 *
 * A build may pin which branch it is on (`VITE_CACHE_STORE`) rather than leave
 * the choice to the platform — see {@link cacheStorePreference}. The outcomes
 * above are unchanged by it.
 *
 * Every path degrades rather than fails. A shell that cannot open the store — a
 * build without the plugin, a registration that failed — is the no-native-store
 * case, and a platform with no `IndexedDB` is the `localStorage` case; neither is
 * an exception that can reach startup.
 */
import {
  IndexedDbPersister,
  LocalStoragePersister,
  TauriStorePersister,
  withFallback,
  type CachePersister,
  type Diagnostic,
  type SnapshotPolicy,
  type TauriStoreLike,
} from "@roomy-space/sdk/browser";

/**
 * The store's file, in the shell's app-data directory. Its own file, the way the
 * IndexedDB adaptor has its own database: the cache must never share storage
 * with the OAuth session, whose loss would fail sign-in rather than a restore.
 */
export const NATIVE_STORE_FILE = "roomy-query-cache.json";

/**
 * The OAuth session's own file — the other half of the rule above.
 *
 * Its consumer is the SDK (`native-session.ts`), which keeps a second copy of
 * the session here so a launch that lost the webview's IndexedDB still
 * restores. Separate from the cache's file for the reason stated there:
 * nothing that spills or grows may be able to take the session with it.
 */
export const NATIVE_SESSION_STORE_FILE = "roomy-oauth-session.json";

/** Is this the Tauri shell rather than a browser tab? */
export function isShell(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/**
 * Which store this build pins, from `VITE_CACHE_STORE`.
 *
 * Unset — every build but the ones that ask — leaves the decision to the
 * platform, which is what makes the shell pick the native store and the web
 * pick IndexedDB without either being named anywhere.
 *
 * The pin exists for the case the platform facts cannot express: the Tauri
 * release build states that its cache lives in the shell's store, so the choice
 * does not depend on the shell's `__TAURI__` global being present at the moment
 * `restoreCache` runs. It selects a branch; it never invents a store, and a
 * pinned store that cannot be opened degrades exactly as the unpinned case does
 * (§4.3).
 */
export type CacheStorePreference = "auto" | "native" | "web";

/** The build's pin, or `"auto"` when it named none. */
export function cacheStorePreference(): CacheStorePreference {
  const pinned = import.meta.env.VITE_CACHE_STORE;
  return pinned === "native" || pinned === "web" ? pinned : "auto";
}

/**
 * Which store this platform uses, as data.
 *
 * Separated from {@link choosePersister} so the decision is a value a test can
 * assert on any platform: composing a persister needs a real `localStorage` and
 * a real `IndexedDB`, while the decision needs only facts about them.
 */
export type CacheStoreChoice =
  /** The shell's native store, with `localStorage` behind it. */
  | { kind: "native"; reason: "shell" }
  /** `localStorage` alone: no store of the platform's own to use. */
  | { kind: "localstorage"; reason: "shell-without-native-store" | "no-indexeddb" }
  /** IndexedDB, with `localStorage` behind it. */
  | { kind: "indexeddb"; reason: "web" };

export interface CacheStoreFacts {
  /** Whether this is the Tauri shell. */
  shell: boolean;
  /** Whether the shell supplied a store it could open. */
  nativeStoreAvailable: boolean;
  /** Whether the platform offers `IndexedDB` at all. */
  indexedDbAvailable: boolean;
  /**
   * The build's pin ({@link cacheStorePreference}). Absent is `"auto"`:
   * decide from the facts above.
   */
  preference?: CacheStorePreference;
}

/**
 * The decision.
 *
 * A shell never consults `IndexedDB`, available or not: the native store is why
 * the shell is treated differently, and the webview's IndexedDB is the thing
 * being avoided on iOS. So the first two arms are decided by `shell` and
 * `nativeStoreAvailable`, and `indexedDbAvailable` only ever decides the third.
 *
 * A pin names the branch directly. It changes which arm is taken, never what
 * that arm returns, so a pinned build still degrades through the same two cases
 * the unpinned one does.
 */
export function chooseCacheStore(facts: CacheStoreFacts): CacheStoreChoice {
  const preference = facts.preference ?? "auto";
  if (preference === "native" || (preference === "auto" && facts.shell)) {
    return facts.nativeStoreAvailable
      ? { kind: "native", reason: "shell" }
      : { kind: "localstorage", reason: "shell-without-native-store" };
  }
  return facts.indexedDbAvailable
    ? { kind: "indexeddb", reason: "web" }
    : { kind: "localstorage", reason: "no-indexeddb" };
}

/**
 * How long the shell's store may take to open before the app gives up on it.
 *
 * The plugin's `load` is an IPC call to the Rust side. A build with the global
 * but without the plugin registered leaves that call unsettled rather than
 * rejecting it, so without a bound the caller waits forever. This runs before
 * the restore, and `startSync` runs after it, so an unbounded wait here would
 * hold the whole authenticated startup on it — not merely the cache. The bound
 * makes that case the no-native-store case it is.
 */
const NATIVE_STORE_OPEN_TIMEOUT_MS = 2_000;

/**
 * Open the shell's native store, or `null` when there is none.
 *
 * A shell that pins `native` is asked for its store even without the
 * `__TAURI__` global: the pin is the build saying it is one. Nothing here
 * throws or hangs: a store that cannot be opened, or that never answers, is the
 * no-native-store case, which {@link chooseCacheStore} handles.
 */
export async function openNativeStore(
  preference: CacheStorePreference = cacheStorePreference(),
): Promise<TauriStoreLike | null> {
  if (!isShell() && preference !== "native") return null;
  try {
    return await openShellStore(NATIVE_STORE_FILE);
  } catch (err) {
    console.warn("cache: native store unavailable; using a web store", err);
    return null;
  }
}

/**
 * One plugin load, one bounded wait.
 *
 * The plugin is imported dynamically, the way `native-push.ts` reaches its
 * plugin: this module is in the web build's graph too, where the plugin's
 * `invoke()` IPC has no shell behind it and must never be evaluated, and a
 * static import cannot express that.
 */
async function openShellStore(file: string): Promise<TauriStoreLike> {
  const { Store } = await import("@tauri-apps/plugin-store");
  return await raceTimeout(
    Store.load(file),
    NATIVE_STORE_OPEN_TIMEOUT_MS,
    `native store ${file} did not open within ${NATIVE_STORE_OPEN_TIMEOUT_MS}ms`,
  );
}

/** The page's one session store; see {@link openNativeSessionStore}. */
let sessionStore: Promise<TauriStoreLike | null> | undefined;

/**
 * The store the OAuth session is mirrored into, opened once per page and only
 * on the shell.
 *
 * `undefined` answers "there is no shell here" — a web build, where the session
 * lives in the webview and always has. `null` answers "there is a shell and no
 * store in it": the plugin is missing, or it never answered. The SDK treats
 * those as different facts (`nativeSessionStore` in the SDK's options), because
 * only the second one means a shell meant to keep a session and could not.
 *
 * Opening is memoised: the file is a singleton on the shell's side, and the
 * login path would otherwise open it a second time on the same page.
 */
export async function openNativeSessionStore(): Promise<
  TauriStoreLike | null | undefined
> {
  if (!isShell() && cacheStorePreference() !== "native") return undefined;
  sessionStore ??= openShellStore(NATIVE_SESSION_STORE_FILE).catch((err) => {
    console.warn(
      "auth: native session store unavailable; the session stays in the webview",
      err,
    );
    return null;
  });
  return sessionStore;
}

/**
 * Resolve with `promise`, or reject once `ms` elapses. The timer is cleared on
 * either outcome, so a store that answers does not leave one pending.
 */
async function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** How many entries a persisted set may hold — the seam's count budget. */
export interface CacheStoreBudget {
  maxEntries?: number;
}

export interface ChoosePersisterOptions {
  policy: SnapshotPolicy;
  budget?: CacheStoreBudget;
  /**
   * The shell's native store, or `null`/absent when there is none. Injected
   * rather than opened here, so the selection is decided by facts a test can
   * supply on any platform.
   */
  nativeStore?: TauriStoreLike | null;
  /** Whether this is the shell. Defaults to {@link isShell}. */
  shell?: boolean;
  /** The build's pin. Defaults to {@link cacheStorePreference}. */
  preference?: CacheStorePreference;
  onDiagnostic?: Diagnostic;
}

/**
 * The persister for one account, on this platform.
 *
 * Each store of the platform's own is wrapped in `withFallback` against
 * `localStorage`, so the seam's one demotion rule applies to the native store
 * exactly as it does to IndexedDB: a store that fails its first read hands the
 * session to `localStorage` rather than holding the app on a store that has
 * stopped answering.
 */
export function choosePersister(opts: ChoosePersisterOptions): CachePersister {
  const { policy, budget } = opts;
  // `console.warn` on absence, matching the seam's own default: a selection
  // this module makes on the app's behalf is still worth saying out loud.
  const report: Diagnostic = opts.onDiagnostic ?? console.warn;
  const localStorage = new LocalStoragePersister({ policy, budget });
  const native = opts.nativeStore ?? null;

  const choice = chooseCacheStore({
    shell: opts.shell ?? isShell(),
    nativeStoreAvailable: native !== null,
    indexedDbAvailable: typeof indexedDB !== "undefined",
    preference: opts.preference ?? cacheStorePreference(),
  });

  switch (choice.kind) {
    case "native":
      return withFallback(
        new TauriStorePersister({ policy, budget, store: native }),
        localStorage,
        report,
      );
    case "indexeddb":
      return withFallback(
        new IndexedDbPersister({ policy, budget }),
        localStorage,
        report,
      );
    case "localstorage":
      report(`cache: using localStorage (${choice.reason})`);
      return localStorage;
  }
}
