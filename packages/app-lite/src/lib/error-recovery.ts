/**
 * Error recovery for the ATProto client.
 *
 * Problem: errors thrown by the ATProto OAuth client / agent (expired or
 * revoked tokens, failed token refreshes, service-auth failures) can leave
 * app-lite in an unusable state — every query fails, the UI is stuck, and
 * the only recovery is a page reload. In the installed PWA there is no way
 * to manually reload, so this is a breaking issue.
 *
 * Solution: detect ATProto session/auth errors and automatically reload the
 * page, which re-runs `init()` and re-attempts session restoration / token
 * refresh. Reloads are debounced and rate-limited so a *persistently* broken
 * session cannot cause an infinite reload loop; once the limit is hit we stop
 * auto-reloading and rely on the manual "Reload" button shown in the
 * `initError` UI.
 *
 * This module is client-only. It is safe to import during SSR — the installer
 * no-ops when `window` is undefined.
 */

const STORAGE_KEY = "roomy:autoReload";

/** Auto-reload at most this many times… */
const MAX_RELOADS = 3;
/** …within this sliding window. */
const WINDOW_MS = 60_000;
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

  const name =
    (err instanceof Error ? err.name : "") ||
    (typeof (err as { constructor?: { name?: string } })?.constructor?.name ===
    "string"
      ? (err as { constructor: { name: string } }).constructor.name
      : "");
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
  if (recoverableNames.some((n) => name.includes(n))) return true;

  // PDS-level auth failure (e.g. getServiceAuth returned 401) — recoverable
  // because a reload re-runs init and re-attempts the OAuth flow. We exclude
  // errors that carry an `nsid`, since those originated from an appserver
  // XRPC call (per-resource authorization, not a session failure).
  if (status === 401 && !nsid) return true;
  if (errorType === "AuthRequired" && !nsid) return true;

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

/** Clear the auto-reload budget. Call before a user-initiated reload. */
export function resetReloadBudget(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * If `err` is a recoverable ATProto error, schedule a debounced,
 * rate-limited page reload. Safe to call from hot paths (query/mutation
 * error callbacks, global handlers) — repeated calls coalesce into a single
 * reload.
 */
export function scheduleAutoReload(err: unknown): void {
  if (!isRecoverableAtprotoError(err)) return;
  if (typeof window === "undefined" || typeof location === "undefined") return;
  if (reloading) return;

  const now = Date.now();
  if (now - lastReloadAt < COOLDOWN_MS) return;

  const recent = reloadTimestamps(now);
  if (recent.length >= MAX_RELOADS) {
    console.warn(
      "[error-recovery] Recoverable ATProto error detected but auto-reload " +
        "limit reached — refusing to reload automatically to avoid a loop.",
      err,
    );
    return;
  }

  recent.push(now);
  persistTimestamps(recent);
  reloading = true;
  lastReloadAt = now;

  const label = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.warn(
    `[error-recovery] Recoverable ATProto error detected — reloading page in ${RELOAD_DELAY_MS}ms.`,
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
 * Install global `error` and `unhandledrejection` listeners that trigger
 * auto-reload on recoverable ATProto errors. Call once, client-side, early
 * in app startup (e.g. from the root layout's `onMount`).
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
}