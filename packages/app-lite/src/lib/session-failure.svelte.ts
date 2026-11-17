/**
 * The session-failure notice: what the app shows when reloading is not the way
 * forward.
 *
 * `error-recovery.ts` decides *whether* a session failure earns a notice and
 * reports the cause; this module holds the copy and the reactive state, and
 * `SessionFailureNotice.svelte` renders it. Keeping the decision and the markup
 * apart means the recovery path stays exercisable without Svelte, and a new
 * cause gains its wording here alone.
 *
 * The two shapes the notice takes are the two things the user can do that the
 * app cannot:
 *
 * - **Reload** — the failure is the device clock. Every request the session
 *   layer signs is rejected for its timestamp, so the pages fail together and a
 *   reload re-runs session restore against the same wrong clock. Correcting or
 *   re-syncing the clock is the fix, and a reload is what makes the app pick it
 *   up.
 * - **Sign in again** — the session is dead where it is held: expired, revoked,
 *   or deleted by another tab or process. No reload brings it back, so the user
 *   is offered the one action that does.
 */

import type { SessionFailureCause } from "./error-recovery";

/**
 * The causes that earn a notice. `session-absent` and `unattributed` are
 * recorded for the corpus but never shown: a call made before a session exists
 * is the login path's normal state, and a cause the classifier could not name
 * gives the user nothing to act on.
 */
export type NoticeCause = Exclude<
  SessionFailureCause,
  "session-absent" | "unattributed"
>;

export interface SessionFailureNotice {
  cause: NoticeCause;
  title: string;
  detail: string;
  /** The one action beyond reading that this notice offers. */
  action: "reload" | "sign-in";
}

/**
 * The copy for each notice, in the user's terms. The clock cases say which way
 * the clock is off, because that is the part they can check: a clock ahead of
 * the server's is rejected before the request is even considered valid, and a
 * clock behind it makes every proof arrive already stale.
 */
const NOTICE_COPY: Record<NoticeCause, Omit<SessionFailureNotice, "cause">> = {
  "dpop-clock-ahead": {
    title: "Your device clock is ahead of ours",
    detail:
      "Roomy's server rejected this device's requests because its clock is " +
      "more than a few minutes ahead. Turn on automatic date and time, then " +
      "reload to sign in again.",
    action: "reload",
  },
  "dpop-proof-expired": {
    title: "Your device clock is behind ours",
    detail:
      "Requests this device signed had already expired when the server saw " +
      "them — usually a clock set a few minutes behind. Turn on automatic date " +
      "and time, then reload to sign in again.",
    action: "reload",
  },
  "refresh-401": {
    title: "Your session could not be renewed",
    detail:
      "The sign-in server refused to renew this session, so nothing more will " +
      "load here. Sign in again to continue.",
    action: "sign-in",
  },
  "session-deleted": {
    title: "Your session was ended somewhere else",
    detail:
      "This session was deleted — signing in on another tab, device or app " +
      "ends the session held here. Sign in again to continue.",
    action: "sign-in",
  },
  "session-expired": {
    title: "Your session has expired",
    detail:
      "Roomy can no longer re-authenticate this session, so nothing more will " +
      "load here. Sign in again to continue.",
    action: "sign-in",
  },
};

let notice = $state<SessionFailureNotice | null>(null);

export const sessionFailure = {
  /** The notice to show, or `null` when there is nothing to show. */
  get notice(): SessionFailureNotice | null {
    return notice;
  },
};

/**
 * Show the notice for `cause`. Repeated reports of one failure — every failed
 * query, the profile fetch, the push re-subscribe — all arrive here; the notice
 * already on screen for the same cause is left as it is, so the user's reading
 * position and focus survive the duplicates.
 */
export function showSessionFailureNotice(cause: SessionFailureCause): void {
  if (notice?.cause === cause) return;
  if (!isNoticeCause(cause)) return;
  notice = { cause, ...NOTICE_COPY[cause] };
}

/** Dismiss the notice without acting on it. */
export function dismissSessionFailureNotice(): void {
  notice = null;
}

function isNoticeCause(cause: SessionFailureCause): cause is NoticeCause {
  return cause in NOTICE_COPY;
}
