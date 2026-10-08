/**
 * Error recovery for app-lite.
 *
 * Problem: errors thrown by the ATProto OAuth client / agent (expired or
 * revoked tokens, failed token refreshes, service-auth failures) can leave
 * app-lite in an unusable state — every query fails, the UI is stuck, and
 * the only recovery is a page reload. In the installed PWA there is no way
 * to manually reload, so this is a breaking issue.
 *
 * Second problem, same shape: a deploy replaces the hashed chunks under
 * `/_app/immutable/`, and a tab opened before it holds an old document. The
 * next dynamic import of a chunk invalidated by that deploy rejects; Vite's
 * `__vitePreload` helper surfaces it as a `vite:preloadError` event on
 * `window` (then rethrows).
 *
 * SvelteKit covers part of this itself, and measurably wins the race for the
 * part it covers: when a *navigation*'s node chunk fails, the router catches
 * the rejection, sees `/_app/version.json` changed and does a full navigation
 * to the intended URL (~60ms). The 600ms `RELOAD_DELAY_MS` below leaves that
 * alone, so this handler only reloads where SvelteKit leaves the rejection
 * unhandled — hover/tap *code preloading* and the app's own dynamic imports
 * (`telemetry/faro.ts`, `sync.svelte.ts`, `nativeUpdate.svelte.ts`), which
 * otherwise surface as unhandled rejections and dead-end.
 *
 * Solution: detect those failures and automatically reload the page, which
 * re-runs `init()` / re-attempts session restoration in the ATProto case, and
 * fetches the current asset graph in the stale-deploy case. Every trigger
 * shares ONE reload path (`scheduleReload`) so the cooldown and budget cannot
 * be sidestepped, and a *persistently* broken state cannot cause an infinite
 * reload loop. When the budget is spent the two triggers diverge: a stale
 * chunk keeps the console record and waits for the window, while a session
 * failure — which no further reload can fix — hands off to the login path via
 * the handler the host registered (`setSessionExpiryHandler`).
 *
 * This module is client-only. It is safe to import during SSR — the installer
 * no-ops when `window` is undefined.
 */

const STORAGE_KEY = "roomy:autoReload";

/** Auto-reload at most this many times… */
const MAX_RELOADS = 3;
/** …within this sliding window. */
const WINDOW_MS = 60_000;
/** Set once the spent budget hands off to the login path; see `claimHandOff`. */
const HAND_OFF_KEY = "roomy:sessionExpiryHandOff";
/** Minimum gap between two auto-reloads (debounces bursts of failed queries). */
const COOLDOWN_MS = 4_000;
/** Delay before actually reloading, so logs flush and events settle. */
const RELOAD_DELAY_MS = 600;

let reloading = false;
let lastReloadAt = 0;

/**
 * True if `err` looks like an ATProto session/auth failure that a page
 * refresh can plausibly fix (by re-running session restore / token refresh).
 *
 * Intentionally narrow: we do NOT auto-reload on generic appserver XRPC
 * errors (e.g. a 401 for a space the user lacks access to) — those have an
 * `nsid` attached by `DirectXrpcClient`'s `toXrpcError` and are not fixed by
 * a reload. We match the OAuth client's dedicated error classes (by name and
 * message, since names may be mangled by bundlers) plus PDS-level 401s that
 * carry no `nsid`.
 */
export function isRecoverableAtprotoError(err: unknown): boolean {
  if (err == null) return false;

  const name = err instanceof Error ? err.name : "";
  const ctorName =
    typeof (err as { constructor?: { name?: string } })?.constructor?.name ===
    "string"
      ? (err as { constructor: { name: string } }).constructor.name
      : "";
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: unknown }).status;
  const nsid = (err as { nsid?: unknown }).nsid;
  const errorType = (err as { errorType?: unknown }).errorType ??
    (err as { error?: unknown }).error;

  // Dedicated OAuth-client error classes. These are unambiguous "session is
  // dead" signals. Match by constructor name (dev) and by message (prod).
  const recoverableNames = [
    "TokenRefreshError",
    "TokenRevokedError",
    "TokenInvalidError",
    "AuthMethodUnsatisfiableError",
    "AuthRequiredError",
  ];
  if (recoverableNames.some((n) => name.includes(n) || ctorName.includes(n)))
    return true;

  // PDS-level auth failure (e.g. getServiceAuth returned 401) — recoverable
  // because a reload re-runs init and re-attempts the OAuth flow. We exclude
  // errors that carry an `nsid`, since those originated from an appserver
  // XRPC call (per-resource authorization, not a session failure).
  if (status === 401 && !nsid) return true;
  if (errorType === "AuthRequired" && !nsid) return true;

  // Everything below classifies by message text alone, which a per-resource
  // appserver failure shares with the OAuth classes above ("Authentication
  // required"). An `nsid` marks that provenance, so such errors stop here.
  if (nsid) return false;

  // Message fallbacks (for plain `Error` throws and mangled class names).
  const patterns = [
    /token.*(refresh|revok|invalid|expired)/i,
    /session.*(expired|revoked|invalid)/i,
    /\bauth(?:entication)?\s+(required|failed)\b/i,
    /\bAuthMethodUnsatisfiable\b/i,
  ];
  if (patterns.some((p) => p.test(message))) return true;

  return false;
}

/** Read persisted auto-reload timestamps within the current window. */
function reloadTimestamps(now: number): number[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is number => typeof t === "number" && now - t < WINDOW_MS);
  } catch {
    return [];
  }
}

function persistTimestamps(ts: number[]): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ts));
  } catch {
    // ignore (private mode / quota)
  }
}

/**
 * Whether this page load is the one that has to hand the user to the login
 * path. Two things have to hold, and both are tab-scoped records in
 * `sessionStorage` — each document imports its own copy of this module, so
 * module state cannot carry either across the reload that ends the hand-off.
 *
 * **Once per spend of the budget.** The hand-off must not itself become the
 * loop it exists to stop: `logout()` reloads into the same tab, and without
 * this the next dead session would hand off and reload again, forever.
 *
 * **Into a document that owns the whole budget.** Signing out ends the
 * session, and with it the reason for the auto-reloads the spent budget is
 * refusing: whatever the next document fails on, it is not the failure that
 * was just proved unfixable by reload. Releasing the budget here makes the
 * landing document an ordinary one — which matters most in the app-password
 * path, where `init()` re-runs a login that a dead credential fails on every
 * load and would otherwise be swallowed as another exhausted-budget session.
 *
 * Both records are window-bounded, so a tab that sits on the login prompt
 * recovers the ordinary behaviour on its own. `resetReloadBudget` clears them
 * the same way, for the login affordances that reset the budget by hand.
 */
function claimHandOff(now: number): boolean {
  if (typeof sessionStorage === "undefined") return true;
  try {
    const at = Number(sessionStorage.getItem(HAND_OFF_KEY));
    if (Number.isFinite(at) && now - at < WINDOW_MS) return false;
    sessionStorage.setItem(HAND_OFF_KEY, String(now));
    sessionStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return true;
  }
}

/**
 * Clear the auto-reload budget, and with it the record of a hand-off already
 * taken. Call when the reloads so far are demonstrably not a loop: before a
 * user-initiated reload, after a client-side navigation completed (see
 * `noteSuccessfulNavigation`), or when the user acts on the login affordance
 * and starts a session deliberately.
 */
export function resetReloadBudget(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(HAND_OFF_KEY);
  } catch {
    // ignore
  }
}

/**
 * The action taken once a session failure has no reloads left — the point at
 * which the reload path cannot be taken. A spent budget is a spent budget for
 * either trigger, so this fires only for the failure a reload cannot fix: a
 * stale chunk is transient (a later deploy clears it), while a dead session
 * never comes back on its own, and reloads have already failed to bring it
 * back. Retrying is over, so the app hands off to the login path, which is
 * where the user gets a way forward.
 */
export type SessionExpiryHandler = (err: unknown) => void;

let sessionExpiryHandler: SessionExpiryHandler | null = null;

/**
 * Register the action taken once a session failure has no reloads left. The
 * host (the root layout) passes `auth.svelte.ts`'s `logout()`; this module holds
 * no import of its own, so the hand-off is exercisable without a session.
 */
export function setSessionExpiryHandler(handler: SessionExpiryHandler | null): void {
  sessionExpiryHandler = handler;
}

/**
 * The single recovery path. Every trigger (ATProto auth failure, stale deploy
 * chunk) funnels through here, so the cooldown and the budget cannot be
 * sidestepped by adding a new caller. Repeated calls coalesce into the one
 * pending reload — or, for a failure no reload can fix, the one hand-off.
 */
function scheduleReload(reason: string, detail: unknown, sessionExpiry = false): void {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  if (reloading) return;

  const now = Date.now();
  if (now - lastReloadAt < COOLDOWN_MS) return;

  const recent = reloadTimestamps(now);
  if (recent.length >= MAX_RELOADS) {
    if (!sessionExpiry) {
      console.warn(
        `[error-recovery] ${reason} but the auto-reload limit is reached — ` +
          "refusing to reload automatically to avoid a loop.",
        detail,
      );
      return;
    }
    if (!claimHandOff(now)) {
      console.warn(
        `[error-recovery] ${reason} and the session has already been handed ` +
          "off to the login path — not repeating it.",
        detail,
      );
      return;
    }
    console.warn(
      `[error-recovery] ${reason} and no auto-reloads remain — ` +
        "handing off to the login path.",
      detail,
    );
    // `reloading` also guards the hand-off: the callers that report one dead
    // session do so many times over (every failed query, the profile fetch,
    // the push re-subscribe), and the host tears all of them down. The flag is
    // never cleared — the hand-off ends the session, so no later reload is
    // legitimately schedulable.
    reloading = true;
    sessionExpiryHandler?.(detail);
    return;
  }

  recent.push(now);
  persistTimestamps(recent);
  reloading = true;
  lastReloadAt = now;

  const label =
    detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail);
  console.warn(
    `[error-recovery] ${reason} — reloading page in ${RELOAD_DELAY_MS}ms.`,
    label,
  );

  window.setTimeout(() => {
    try {
      location.reload();
    } catch (e) {
      console.error("[error-recovery] location.reload() threw", e);
      reloading = false;
    }
  }, RELOAD_DELAY_MS);
}

/**
 * If `err` is a recoverable ATProto error, schedule a debounced,
 * rate-limited page reload — or, once the reload budget is spent, hand off to
 * the login path (see `setSessionExpiryHandler`). Safe to call from hot paths
 * (query/mutation error callbacks, global handlers): repeated calls coalesce
 * into a single reload, or a single hand-off.
 */
export function scheduleAutoReload(err: unknown): void {
  if (!isRecoverableAtprotoError(err)) return;
  scheduleReload("Recoverable ATProto error detected", err, true);
}

/**
 * A navigation that completed is proof that the running document's asset graph
 * resolves, so the auto-reloads before it were deploy skew rather than a loop —
 * the budget comes back. Without this, a user who hits several benign stale
 * chunks inside the window stays stuck even though every reload worked.
 *
 * Only user-driven navigations (`link`, `popstate`) refill it. Programmatic
 * ones must not: a reload is followed unattended by the post-login return-URL
 * `goto` in `auth.svelte.ts`, and a stale-chunk error after *that* would refill
 * the budget and reload again — an unbounded loop in a client a reload cannot
 * fix, which is exactly what `MAX_RELOADS` exists to stop. The initial `enter`
 * (hydration) is likewise excluded. The budget is a sliding `WINDOW_MS` window,
 * so a refused client recovers on its own once the window passes.
 */
export function noteSuccessfulNavigation(type: string): void {
  if (type !== "link" && type !== "popstate") return;
  resetReloadBudget();
}

/**
 * Install the global listeners that trigger auto-reload: `error` /
 * `unhandledrejection` for recoverable ATProto errors, and Vite's
 * `vite:preloadError` for dynamic imports invalidated by a deploy. Call once,
 * client-side, early in app startup (e.g. from the root layout's `onMount`).
 */
export function installGlobalErrorRecovery(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("unhandledrejection", (ev) => {
    scheduleAutoReload(ev.reason);
  });

  window.addEventListener("error", (ev) => {
    // `ev.error` is the thrown Error (when available); fall back to message.
    scheduleAutoReload(ev.error ?? ev.message);
  });

  // Fired by Vite's `__vitePreload` helper, which also rethrows the original
  // error (so it reaches the `error` listener above too — that one ignores it,
  // since a module-load failure is not an ATProto error). Without this handler
  // the rethrow reaches the user as nothing and the navigation dead-ends.
  //
  // The event itself is the signal: Vite dispatches it only when a dynamic
  // import (or one of its CSS preloads) was rejected. So the payload is for
  // logging alone and is deliberately not matched against message text, which
  // browsers word differently ("Failed to fetch dynamically imported module: …",
  // "error loading dynamically imported module: …", "Importing a module script
  // failed.").
  window.addEventListener("vite:preloadError", (ev) => {
    scheduleReload("Stale deploy chunk failed to load", "payload" in ev ? ev.payload : ev);
  });
}