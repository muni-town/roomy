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
 * be sidestepped by adding a new caller, and a *persistently* broken state
 * cannot cause an infinite reload loop. When the budget is spent the two
 * triggers diverge: a stale chunk keeps the console record and waits for the
 * window, while a session failure — which no further reload can fix — hands off
 * to the login path via the handler the host registered
 * (`setSessionExpiryHandler`).
 *
 * Which recovery a session failure is worth depends on what failed, and that
 * used to be invisible: every cause reached this module as a bare 401, so a
 * device clock the server rejects, a session deleted in another tab and an
 * ordinary refresh all took the same three reloads and ended the same way.
 * `classifySessionFailure` names the cause, and each cause carries a
 * disposition (see `SessionFailureDisposition`): the clock failure spends no
 * reload at all and shows the user a notice naming the clock; a session held
 * dead elsewhere spends one, then shows the same notice with a way to sign in;
 * only an unattributed failure still spends the shared budget. The cause also
 * rides on every log line and telemetry event, so the corpus is countable by
 * cause instead of by sentence.
 *
 * This module is client-only. It is safe to import during SSR — the installer
 * no-ops when `window` is undefined, and the handlers it reports through are
 * never registered outside the browser.
 */

const STORAGE_KEY = "roomy:autoReload";

/** Auto-reload at most this many times… */
const MAX_RELOADS = 3;
/** …within this sliding window. */
const WINDOW_MS = 60_000;
/** Set once the spent budget hands off to the login path; see `claimHandOff`. */
const HAND_OFF_KEY = "roomy:sessionExpiryHandOff";
/**
 * Set once a tab has spent the one reload a dead session is worth; see
 * `scheduleSessionReload`. Kept apart from `STORAGE_KEY` because that budget
 * bounds reload *loops*, while this bounds reloads of a failure the reload is
 * not expected to repair — a dead session does not get three attempts.
 */
const SESSION_RECOVERY_KEY = "roomy:sessionRecoveryReload";
/** Minimum gap between two auto-reloads (debounces bursts of failed queries). */
const COOLDOWN_MS = 4_000;
/** Delay before actually reloading, so logs flush and events settle. */
const RELOAD_DELAY_MS = 600;

let reloading = false;
let lastReloadAt = 0;

/**
 * The distinct session failures the client can tell apart, and what a page
 * reload is worth to each.
 *
 * Every one of them arrives as a 401 from the session layer, so before this
 * classification existed the recovery path could only see "dead session" and
 * the telemetry corpus read as one sentence whatever had actually happened.
 * Each cause is matched on the text the thrower put on the error — the
 * deployed session layer's sentence, `@atproto/oauth-client`'s, or the DPoP
 * proof error the authorization server returned — and its `disposition` is the
 * recovery decision that follows:
 *
 * - `notice`: a reload cannot help and must not be spent. The device clock is
 *   the cause, the reload would re-run session restore against the same clock,
 *   and the user is the only one who can change it.
 * - `single-reload`: the session is dead where it is held, so a reload confirms
 *   it at most once; after that the user gets the cause and a way to sign in.
 * - `reload`: ordinary — reloading re-attempts session restore / token
 *   exchange, which is what the shared `MAX_RELOADS` budget exists for.
 * - `label`: recorded for the corpus and otherwise ignored. A call made before
 *   a session exists is the login path's normal state, not a failure to
 *   recover from, and reloading for it would loop every unsign-in'd page load.
 */
export type SessionFailureCause =
  | "dpop-clock-ahead"
  | "dpop-proof-expired"
  | "refresh-401"
  | "session-deleted"
  | "session-expired"
  | "session-absent"
  | "unattributed";

export type SessionFailureDisposition =
  | "reload"
  | "single-reload"
  | "notice"
  | "label";

/** A named session failure: what broke, and what recovery it is worth. */
export interface SessionFailure {
  cause: SessionFailureCause;
  disposition: SessionFailureDisposition;
}

/**
 * A DPoP proof stamped in this device's future: the proof's `iat` is later than
 * the authorization server's clock plus its acceptance window, so the device
 * clock is ahead of the server's. `iat is in the future` is the authorization
 * server's own wording for it.
 */
const DPOP_CLOCK_AHEAD =
  /\biat\b[^\n]{0,40}\bin the future\b|\bdpop\b[^\n]{0,60}\bin the future\b/i;

/**
 * A DPoP proof that was already stale when it arrived: the proof lives minutes,
 * so `expired` means the request outlived it — a device clock behind the
 * server's, or a request that sat in a sleeping tab.
 */
const DPOP_PROOF_EXPIRED = /\bdpop\b[^\n]{0,80}\bexpired\b/i;

/**
 * `@atproto/oauth-client`'s sentence for a session another tab or process
 * removed from the shared store (`session-getter.ts`).
 */
const SESSION_DELETED = /deleted by another process/i;

/** The deployed session layer's sentence for a session it will not honour again. */
const SESSION_EXPIRED = /re-?authenticate|session\b[^\n]{0,60}\b(expired|revoked)\b/i;

/** This app's own throw when no agent backs a call (`auth.svelte.ts`, `arbiter.ts`). */
const SESSION_ABSENT = /\bnot authenticated\b/i;

/** A refused token exchange: the OAuth client's message, or a bare `invalid_grant`. */
const REFRESH_REJECTED =
  /\btoken\b[^\n]{0,40}\b(refresh|revok|invalid|expired)\b|invalid_grant/i;

/**
 * The causes in match order. A clock failure states its cause in the text, so
 * it is checked before the generic session sentence it can also carry ("the
 * session expired" describes the symptom of a wrong clock just as well).
 */
const CAUSE_MATCHERS: ReadonlyArray<{ pattern: RegExp; failure: SessionFailure }> = [
  {
    pattern: DPOP_CLOCK_AHEAD,
    failure: { cause: "dpop-clock-ahead", disposition: "notice" },
  },
  {
    pattern: DPOP_PROOF_EXPIRED,
    failure: { cause: "dpop-proof-expired", disposition: "notice" },
  },
  {
    pattern: SESSION_DELETED,
    failure: { cause: "session-deleted", disposition: "single-reload" },
  },
  {
    pattern: SESSION_EXPIRED,
    failure: { cause: "session-expired", disposition: "single-reload" },
  },
  {
    pattern: SESSION_ABSENT,
    failure: { cause: "session-absent", disposition: "label" },
  },
  {
    pattern: REFRESH_REJECTED,
    failure: { cause: "refresh-401", disposition: "single-reload" },
  },
];

/**
 * The OAuth client's refresh rejections, matched by class name because bundlers
 * may mangle the message. `AuthMethodUnsatisfiableError` and `AuthRequiredError`
 * are deliberately absent: they flag a client configuration problem, which
 * `isRecoverableAtprotoError` still treats as an ordinary recoverable failure.
 */
const REFRESH_FAILURE_CLASSES = [
  "TokenRefreshError",
  "TokenRevokedError",
  "TokenInvalidError",
];

/**
 * A property read from an error of unknown shape, or `undefined`. Errors reach
 * this module as `unknown` — thrown by the SDK, the OAuth client or the session
 * layer — so every field the classifiers read is validated one `in` check at a
 * time rather than asserted into a shape it may not have.
 */
function errorField(err: unknown, key: string): unknown {
  if (err == null || typeof err !== "object") return undefined;
  if (!(key in err)) return undefined;
  // The `in` check proves the key exists; a dynamic key still needs an index
  // signature to read it.
  return (err as Record<string, unknown>)[key];
}

/**
 * The class names `err` answers to, space-separated: its `name` and its
 * constructor's. Bundlers mangle one or the other, so the OAuth classes are
 * matched against both.
 */
function errorClassName(err: unknown): string {
  const ctor = errorField(err, "constructor");
  return `${err instanceof Error ? err.name : ""} ${
    typeof ctor === "function" ? ctor.name : ""
  }`;
}

/**
 * Every string the error carries that could name a session-failure class: its
 * message, the OAuth response fields, and the `cause` it was wrapped from (a
 * `TokenRefreshError` carries the authorization server's `invalid_grant` that
 * way). Bounded in depth and in field names — this runs on every error the
 * query, mutation and global handlers see.
 */
function failureText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current != null; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (current instanceof Error) parts.push(current.message);
    for (const key of [
      "error",
      "error_description",
      "errorDescription",
      "reason",
      "body",
    ]) {
      const value = errorField(current, key);
      if (typeof value === "string") {
        parts.push(value);
        continue;
      }
      if (value == null || typeof value !== "object") continue;
      for (const nestedKey of ["error", "error_description", "message"]) {
        const nested = errorField(value, nestedKey);
        if (typeof nested === "string") parts.push(nested);
      }
    }
    current = errorField(current, "cause");
  }
  return parts.join("\n");
}

/**
 * Name the session failure `err` reports, or `null` if it names none of them.
 *
 * A named cause is what makes the failure recoverable or not: the classifiers
 * below are consulted before the `nsid` guard in `isRecoverableAtprotoError`,
 * because a session-layer failure proxied through an XRPC call keeps the same
 * meaning as a bare one.
 */
export function classifySessionFailure(err: unknown): SessionFailure | null {
  if (err == null) return null;

  const text = failureText(err);
  for (const { pattern, failure } of CAUSE_MATCHERS) {
    if (pattern.test(text)) return failure;
  }

  const className = errorClassName(err);
  if (REFRESH_FAILURE_CLASSES.some((n) => className.includes(n))) {
    return { cause: "refresh-401", disposition: "single-reload" };
  }

  return null;
}

/**
 * The structured field to append to a log line that reports `err`: `{ cause }`
 * when the error names a session failure, `undefined` when it does not, which
 * leaves the line exactly as it was.
 *
 * Every call site that logs a session failure adds this, so the corpus separates
 * a device clock the server rejected from a session that expired from one
 * another tab deleted — the distinction the classifier makes and the log line
 * alone loses.
 */
export function sessionFailureFields(
  err: unknown,
): { cause: SessionFailureCause } | undefined {
  const cause = classifySessionFailure(err)?.cause;
  return cause === undefined ? undefined : { cause };
}

/**
 * True if `err` looks like an ATProto session/auth failure that a page
 * refresh can plausibly fix (by re-running session restore / token refresh).
 *
 * Intentionally narrow: we do NOT auto-reload on generic appserver XRPC
 * errors (e.g. a 401 for a space the user lacks access to) — those have an
 * `nsid` attached by `DirectXrpcClient`'s `toXrpcError` and are not fixed by
 * a reload. A named session failure answers for itself first (a device clock a
 * reload cannot correct is not recoverable; a dead session is worth the one
 * reload `single-reload` allows). What is left is matched on the OAuth client's
 * dedicated error classes (by name and message, since names may be mangled by
 * bundlers) plus PDS-level 401s that carry no `nsid`.
 */
export function isRecoverableAtprotoError(err: unknown): boolean {
  if (err == null) return false;

  const failure = classifySessionFailure(err);
  if (failure) {
    return (
      failure.disposition === "reload" || failure.disposition === "single-reload"
    );
  }

  const className = errorClassName(err);
  const status = errorField(err, "status");
  const nsid = errorField(err, "nsid");
  const errorType = errorField(err, "errorType") ?? errorField(err, "error");

  // OAuth-client classes that name no session cause above. They are
  // unambiguous "session cannot proceed" signals; a reload re-runs the flow.
  if (REFRESH_FAILURE_CLASSES.concat([
    "AuthMethodUnsatisfiableError",
    "AuthRequiredError",
  ]).some((n) => className.includes(n)))
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
    /\bauth(?:entication)?\s+(required|failed)\b/i,
    /\bAuthMethodUnsatisfiable\b/i,
  ];
  const message = err instanceof Error ? err.message : String(err);
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
 * taken and of the one reload a dead session was allowed. Call when the reloads
 * so far are demonstrably not a loop: before a user-initiated reload, after a
 * client-side navigation completed (see `noteSuccessfulNavigation`), or when
 * the user acts on the login affordance and starts a session deliberately.
 */
export function resetReloadBudget(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(HAND_OFF_KEY);
    sessionStorage.removeItem(SESSION_RECOVERY_KEY);
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
 * The user-visible notice a session failure earns when reloading is not the
 * way forward: the clock the server rejected, or a session that is dead where
 * it is held. The host renders it with the affordance its cause implies —
 * reload for the clock, sign in for a dead session; this module holds no copy
 * and no markup, so the decision to show one stays here and the presentation
 * stays in the component.
 */
export type SessionFailureNoticeHandler = (
  failure: SessionFailure,
  err: unknown,
) => void;

let sessionFailureNoticeHandler: SessionFailureNoticeHandler | null = null;

/**
 * Register where a session-failure notice goes. The root layout wires it to the
 * notice component's state; unregistered (tests, SSR) the notice is logged and
 * dropped.
 */
export function setSessionFailureNoticeHandler(
  handler: SessionFailureNoticeHandler | null,
): void {
  sessionFailureNoticeHandler = handler;
}

/**
 * Every classified session failure, whatever recovery it earns, reported before
 * that recovery runs: the host maps it onto the telemetry event that makes the
 * corpus countable by cause. Separate from the notice handler because a failure
 * that reloads is worth counting too.
 */
export type SessionFailureObserver = (failure: SessionFailure, err: unknown) => void;

let sessionFailureObserver: SessionFailureObserver | null = null;

/** Register the session-failure observer; see `SessionFailureObserver`. */
export function setSessionFailureObserver(
  observer: SessionFailureObserver | null,
): void {
  sessionFailureObserver = observer;
}

/**
 * What each cause is worth in words, for the log line and the notice title. The
 * clock cases name the clock: it is on the user's device, it is why every
 * surface fails at once, and a reload re-runs restore against the same clock.
 */
const NOTICE_REASONS: Record<SessionFailureCause, string> = {
  "dpop-clock-ahead":
    "DPoP proof rejected: this device's clock is ahead of the server's",
  "dpop-proof-expired":
    "DPoP proof rejected: the proof had already expired when it arrived",
  "refresh-401": "the token refresh was rejected",
  "session-deleted": "the session was deleted by another process",
  "session-expired": "the session is no longer valid",
  "session-absent": "no session backs this call",
  unattributed: "an unattributed session failure",
};

/** The failure as it reads in a log line's second argument. */
function failureLabel(detail: unknown): string {
  return detail instanceof Error
    ? `${detail.name}: ${detail.message}`
    : String(detail);
}

/**
 * Show the notice for `failure`, and say in the console why no reload is coming.
 *
 * Repeated reports of one failure all land here — one dead session fails every
 * query, the profile fetch and the push re-subscribe — so the notice is raised
 * once per cause per document. A dismissed notice stays dismissed: the failure
 * it names has not changed in the second between two failed queries, and
 * re-opening it under the user's cursor would be the reload loop's annoyance
 * without its reload.
 */
function showSessionFailureNotice(failure: SessionFailure, err: unknown): void {
  if (notifiedCauses.has(failure.cause)) return;
  notifiedCauses.add(failure.cause);
  console.warn(
    `[error-recovery] ${NOTICE_REASONS[failure.cause]} — showing the notice ` +
      "instead of reloading.",
    failureLabel(err),
    { cause: failure.cause, disposition: failure.disposition },
  );
  sessionFailureNoticeHandler?.(failure, err);
}

/** Causes whose notice this document has already shown; see `showSessionFailureNotice`. */
const notifiedCauses = new Set<SessionFailureCause>();
const labelledCauses = new Set<SessionFailureCause>();

/**
 * The single recovery path for a reload. Every trigger (ATProto auth failure,
 * stale deploy chunk) funnels through here, so the cooldown and the budget
 * cannot be sidestepped by adding a new caller. Repeated calls coalesce into the
 * one pending reload — or, for a failure no reload can fix, the one hand-off.
 *
 * `failure` is the named session failure behind the call, when there is one: it
 * rides on every log line this path writes, so the corpus stays countable by
 * cause. The message text itself is unchanged — dashboards read it.
 */
function scheduleReload(
  reason: string,
  detail: unknown,
  sessionExpiry = false,
  failure?: SessionFailure,
): void {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  if (reloading) return;

  const fields = failure
    ? { cause: failure.cause, disposition: failure.disposition }
    : undefined;

  const now = Date.now();
  if (now - lastReloadAt < COOLDOWN_MS) return;

  const recent = reloadTimestamps(now);
  if (recent.length >= MAX_RELOADS) {
    if (!sessionExpiry) {
      console.warn(
        `[error-recovery] ${reason} but the auto-reload limit is reached — ` +
          "refusing to reload automatically to avoid a loop.",
        detail,
        fields,
      );
      return;
    }
    if (!claimHandOff(now)) {
      console.warn(
        `[error-recovery] ${reason} and the session has already been handed ` +
          "off to the login path — not repeating it.",
        detail,
        fields,
      );
      return;
    }
    console.warn(
      `[error-recovery] ${reason} and no auto-reloads remain — ` +
        "handing off to the login path.",
      detail,
      fields,
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

  console.warn(
    `[error-recovery] ${reason} — reloading page in ${RELOAD_DELAY_MS}ms.`,
    failureLabel(detail),
    fields,
  );

  window.setTimeout(() => {
    try {
      location.reload();
    } catch (e) {
      console.error("[error-recovery] location.reload() threw", e, fields);
      reloading = false;
    }
  }, RELOAD_DELAY_MS);
}

/** Whether this tab has already spent the one reload a dead session is worth. */
function sessionRecoverySpent(now: number): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    const at = Number(sessionStorage.getItem(SESSION_RECOVERY_KEY));
    return Number.isFinite(at) && now - at < WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * A session failure a reload cannot repair gets one reload, then the notice.
 *
 * The reload is not pointless — it re-runs session restore, which is the only
 * way to know whether the session really is gone where it is held, and a second
 * document may have a fresh view of the store. It is pointless *repeatedly*:
 * before this, a dead session spent the whole three-reload budget and ended with
 * a sign-out nobody explained. Here the second report of the same failure inside
 * `WINDOW_MS` stops retrying and hands the user the cause and a way to sign in,
 * which is a decision they can make and the reload cannot.
 */
function scheduleSessionReload(failure: SessionFailure, err: unknown): void {
  if (typeof window === "undefined" || typeof location === "undefined") return;
  // A reload is already on its way for this failure: reporting it again is the
  // normal case (one dead session fails every query at once).
  if (reloading) return;

  const now = Date.now();
  if (sessionRecoverySpent(now) || reloadTimestamps(now).length >= MAX_RELOADS) {
    showSessionFailureNotice(failure, err);
    return;
  }

  try {
    sessionStorage.setItem(SESSION_RECOVERY_KEY, String(now));
  } catch {
    // ignore (private mode / quota); the shared budget still bounds the loop
  }
  scheduleReload(
    "Session failure that a reload cannot repair",
    err,
    false,
    failure,
  );
}

/**
 * If `err` names a session failure, take the recovery that cause is worth. Every
 * one of them is reported to the observer first, so the corpus counts causes even
 * where no recovery follows.
 *
 * What a reload is worth to each cause is the decision this function makes, and
 * the three outcomes are deliberately different (see `SessionFailureDisposition`):
 * a clock failure must not reload, a dead session gets one, and an unattributed
 * failure keeps the behaviour the shared budget was built for. Safe to call from
 * hot paths (query/mutation error callbacks, global handlers): repeated calls
 * coalesce into a single action.
 */
export function scheduleAutoReload(err: unknown): void {
  const failure = classifySessionFailure(err);
  if (failure !== null) {
    if (failure.disposition === "label") {
      // A call made before a session exists fails on every startup query. It is
      // still reported — the corpus needs the count — but once per document and
      // with no recovery: the login path is already what the user is looking at.
      if (labelledCauses.has(failure.cause)) return;
      labelledCauses.add(failure.cause);
      sessionFailureObserver?.(failure, err);
      console.warn(
        `[error-recovery] ${NOTICE_REASONS[failure.cause]} — no recovery action.`,
        failureLabel(err),
        { cause: failure.cause, disposition: failure.disposition },
      );
      return;
    }

    sessionFailureObserver?.(failure, err);
    switch (failure.disposition) {
      case "notice":
        showSessionFailureNotice(failure, err);
        return;
      case "single-reload":
        scheduleSessionReload(failure, err);
        return;
      case "reload":
        scheduleReload(
          "Recoverable ATProto error detected",
          err,
          true,
          failure,
        );
        return;
    }
  }

  if (!isRecoverableAtprotoError(err)) return;
  const unattributed: SessionFailure = {
    cause: "unattributed",
    disposition: "reload",
  };
  sessionFailureObserver?.(unattributed, err);
  scheduleReload("Recoverable ATProto error detected", err, true, unattributed);
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