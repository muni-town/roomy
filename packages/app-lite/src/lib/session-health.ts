/**
 * Watch the requests that carry the session, and report a session the server
 * keeps rejecting.
 *
 * The recovery machinery in `error-recovery.ts` has four triggers, and every
 * one of them needs an error to *reach* it: a TanStack query/mutation failure,
 * an `init()` failure, an unhandled rejection, or the chat-input send path. A
 * rejected session request raised inside the OAuth client reaches none of
 * them — the client hands the rejection back to the caller, and the two app
 * paths that touch the session (`trackGrant`, `updateProfile`) log it with
 * `console.warn` and move on. A tab whose token is dead then retries it
 * indefinitely, one request every few seconds, rendering from the persisted
 * cache and never reaching the login path.
 *
 * The OAuth client already accepts a `fetch` (see `createOAuthClient` in the
 * SDK), so this module wraps it: every request to the session origin is
 * classified, a run of rejections is counted, and the run is handed to
 * `scheduleAutoReload` once it is long enough to mean the session — not a
 * transient blip — is dead.
 *
 * Two properties make the bound safe to cross:
 *
 * **A count is consecutive.** Any response that is not a session rejection
 * ends it. The observed cadence is roughly one request every 16 s, so
 * `SESSION_FAILURE_LIMIT` at that rate is about three minutes; a HappyView
 * restart that fails a couple of requests never escalates.
 *
 * **The count survives the reload it triggers.** The auto-reload budget only
 * spends itself when reloads land inside its one-minute window, and at this
 * cadence a reload per run would be three minutes apart — so a fresh count in
 * every document would reload forever and never reach the hand-off. Carrying
 * the count across documents (in `sessionStorage`, for as long as the tab keeps
 * failing) lets the *existing* budget decide: the reloaded document escalates
 * on its first rejection, so three reloads land inside the window and the
 * fourth escalation hands off to the login path. Any successful response from
 * the session origin resets the count, so a reload that restored a live session
 * clears it before a stray rejection can use it.
 *
 * Client-only, but it touches no browser globals unless it has to, so the
 * counting is exercisable under `node --test`.
 */

/**
 * Consecutive rejected requests to the session origin that escalate.
 *
 * At the observed cadence (~4 requests/minute) this is a little over three
 * minutes of *unbroken* rejection. The point is not to catch the first failure
 * — a HappyView blip, a laptop waking from sleep, or one dropped connection
 * must not log anyone out — but to stop a session that is provably unusable.
 */
export const SESSION_FAILURE_LIMIT = 12;

/**
 * How long a run survives without a session request. A tab that has not talked
 * to the session origin for this long is not in the same failing session any
 * more — the tab may have been backgrounded for an hour — so the run starts
 * over rather than escalating on the first rejection after the gap.
 */
export const STREAK_TTL_MS = 10 * 60_000;

/** A run of session rejections that reached the limit. */
export interface SessionFailure {
  /** The origin whose requests carry the session. */
  origin: string;
  /** How many consecutive requests it rejected, including this one. */
  count: number;
  /** `401`, or `0` for a request that never got a response. */
  status: number;
  /** The rejected request's URL, for the log store. */
  url: string;
}

/** What a run is persisted as, so it survives the reload it triggers. */
interface PersistedStreak {
  count: number;
  /** `Date.now()` of the last change; the run expires `STREAK_TTL_MS` later. */
  at: number;
}

export interface SessionHealthOptions {
  /**
   * The origin whose requests carry the session (`CONFIG.happyviewEndpoint`).
   * Requests to any other origin are forwarded untouched: an appserver 401 for
   * a room the user cannot read is per-resource authorization, not a dead
   * session, and must not be counted here.
   */
  origin: string;
  /** The fetch to wrap. Defaults to the global one. */
  fetch?: typeof globalThis.fetch;
  /** Consecutive rejections that escalate. Defaults to `SESSION_FAILURE_LIMIT`. */
  limit?: number;
  /**
   * Where a run is carried between documents. Defaults to `sessionStorage`
   * (per tab, and gone when the tab closes); `null` keeps it in memory.
   */
  storage?: SessionStore | null;
  /**
   * Called once per run of rejections, at the moment the run crosses `limit`.
   * Later rejections in the same document do not call it again; a success
   * resets the run.
   */
  onExhausted: (failure: SessionFailure) => void;
  /**
   * Called whenever the length of the current run changes, including the reset
   * to zero. This is the telemetry seam: a sample per change is what makes the
   * next occurrence measurable without reading request spans.
   */
  onStreak?: (streak: number) => void;
  /** Base for resolving relative request URLs. Defaults to `location.href`. */
  base?: string;
}

/**
 * An error the recovery path recognises as a dead session.
 *
 * `isRecoverableAtprotoError` reads a bare `401` (no `nsid`) as a session
 * failure; building the error that way is what lets this trigger share the
 * reload budget and the login hand-off with every other session failure,
 * instead of adding a second recovery convention.
 */
export function sessionFailureError(failure: SessionFailure): Error {
  const err = new Error(
    `Session rejected ${failure.count} consecutive times by ${failure.origin}`,
  );
  err.name = "SessionRejectedError";
  return Object.assign(err, { status: 401, sessionFailure: failure });
}

/** The part of `sessionStorage` this module reads and writes. */
export type SessionStore = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

/** Where a run for `origin` is kept; the same key is read on the next document. */
function streakKey(origin: string): string {
  return `roomy:sessionStreak:${origin}`;
}

/**
 * Forget the run for `origin`. Call when the session it describes is being
 * ended: the run belongs to the session, and a document that has no session
 * must not inherit one — otherwise the first rejection of the next sign-in
 * would escalate on the strength of the previous session's failures.
 */
export function resetSessionStreak(
  origin: string,
  storage: SessionStore | null = typeof sessionStorage !== "undefined"
    ? sessionStorage
    : null,
): void {
  if (!storage) return;
  try {
    storage.removeItem(streakKey(requestUrl(origin)?.origin ?? origin));
  } catch {
    // ignore (private mode / quota)
  }
}

/** The URL of a `fetch` input, resolved against `base`; `null` if it is not one. */
function requestUrl(input: RequestInfo | URL, base?: string): URL | null {
  const raw =
    typeof Request !== "undefined" && input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : String(input);
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/**
 * Wrap `fetch` so a run of rejected session requests escalates.
 *
 * Only requests to `options.origin` are classified, and only two outcomes
 * count as rejections: a `401` response, and a request that never got one
 * (`status: 0` — the rejected promise form and the `Response` form are both
 * counted). Everything else ends the run. Responses and rejections are passed
 * through unchanged; this wrapper observes, it never swallows.
 */
export function createSessionAwareFetch(
  options: SessionHealthOptions,
): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const limit = options.limit ?? SESSION_FAILURE_LIMIT;
  const base =
    options.base ?? (typeof location !== "undefined" ? location.href : undefined);
  const sessionOrigin = requestUrl(options.origin, base)?.origin ?? null;
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof sessionStorage !== "undefined"
        ? sessionStorage
        : null;
  const storageKey = sessionOrigin === null ? null : streakKey(sessionOrigin);

  const readStreak = (now: number): number => {
    if (!storage || !storageKey) return 0;
    try {
      const raw: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
      if (typeof raw !== "object" || raw === null) return 0;
      if (!("count" in raw) || !("at" in raw)) return 0;
      const { count, at } = raw;
      if (
        typeof count !== "number" ||
        typeof at !== "number" ||
        !Number.isFinite(count) ||
        count < 0 ||
        now - at > STREAK_TTL_MS
      ) {
        return 0;
      }
      return count;
    } catch {
      return 0;
    }
  };

  const writeStreak = (count: number, now: number): void => {
    if (!storage || !storageKey) return;
    try {
      const streak: PersistedStreak = { count, at: now };
      storage.setItem(storageKey, JSON.stringify(streak));
    } catch {
      // Private mode / quota: the in-memory run still works for this document.
    }
  };

  /**
   * Consecutive rejections per origin, and whether this document has already
   * escalated this run. The flag is deliberately per document: a document that
   * inherited a spent run still has to hand its own failure to the budget,
   * which is what makes the budget spend.
   */
  const runs = new Map<string, { count: number; escalated: boolean }>();

  const record = (url: URL, status: number): void => {
    const now = Date.now();
    const run = runs.get(url.origin) ?? {
      count: readStreak(now),
      escalated: false,
    };
    runs.set(url.origin, run);

    if (status !== 401 && status !== 0) {
      if (run.count === 0) return;
      run.count = 0;
      run.escalated = false;
      writeStreak(0, now);
      options.onStreak?.(0);
      return;
    }

    run.count += 1;
    writeStreak(run.count, now);
    options.onStreak?.(run.count);
    if (run.escalated || run.count < limit) return;
    run.escalated = true;
    options.onExhausted({
      origin: url.origin,
      count: run.count,
      status,
      url: url.href,
    });
  };

  const sessionAwareFetch: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input, base);
    if (url === null || sessionOrigin === null || url.origin !== sessionOrigin) {
      return baseFetch(input, init);
    }

    try {
      const response = await baseFetch(input, init);
      record(url, response.status);
      return response;
    } catch (err) {
      // A request the caller cancelled says nothing about the session.
      const cancelled =
        typeof err === "object" &&
        err !== null &&
        "name" in err &&
        err.name === "AbortError";
      if (!cancelled) record(url, 0);
      throw err;
    }
  };

  return sessionAwareFetch;
}
