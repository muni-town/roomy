/**
 * Tests for recovery from an unhandled `vite:preloadError`.
 *
 * A deploy replaces the hashed chunks under `/_app/immutable/`. A tab opened
 * before it holds an old document, so the next dynamic import of a chunk
 * invalidated by that deploy rejects; Vite's `__vitePreload` helper dispatches a
 * `vite:preloadError` event on `window` (and rethrows). Unhandled, the rethrow
 * is a dead-end with no recovery.
 *
 * What these tests pin is the recovery contract: the event reloads the page,
 * through the SAME rate-limited path as the ATProto trigger, so the budget still
 * bounds it across page loads.
 *
 * A second contract lives here too: `isRecoverableAtprotoError` decides which
 * errors qualify at all. An appserver XRPC failure carries an `nsid` and is
 * per-resource authorization, not a dead session, so it must not reload — even
 * when its message ("Authentication required") reads like an OAuth-client one.
 *
 * Deliberate limits of this coverage:
 *
 * 1. The failure is synthetic — a hand-dispatched event, not real deploy skew.
 *    Reproducing skew needs two builds served concurrently.
 * 2. It drives `error-recovery.ts` directly rather than booting SvelteKit, so it
 *    cannot prove a real navigation surfaces the event. The chain that makes it
 *    reachable lives in the build: SvelteKit loads node chunks via
 *    `() => import('./nodes/N.js')`, which Vite rewrites into `__vitePreload`.
 * 3. SvelteKit handles part of the real skew itself (a failed *navigation* chunk
 *    triggers its own version check and full navigation), so this handler is the
 *    net for the imports SvelteKit leaves unhandled rather than the only recovery.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the file
 * runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifySessionFailure,
  isRecoverableAtprotoError,
} from "./error-recovery.ts";
import type {
  installGlobalErrorRecovery,
  noteSuccessfulNavigation,
  SessionFailure,
  setSessionExpiryHandler,
  setSessionFailureNoticeHandler,
  setSessionFailureObserver,
} from "./error-recovery.ts";

/** The documented budget. Not exported; pinned here as observable behavior. */
const MAX_RELOADS = 3;
/** The sliding window the budget is recorded within. */
const WINDOW_MS = 60_000;

const STORAGE_KEY = "roomy:autoReload";

type RecoveryModule = {
  installGlobalErrorRecovery: typeof installGlobalErrorRecovery;
  noteSuccessfulNavigation: typeof noteSuccessfulNavigation;
  setSessionExpiryHandler: typeof setSessionExpiryHandler;
  setSessionFailureNoticeHandler: typeof setSessionFailureNoticeHandler;
  setSessionFailureObserver: typeof setSessionFailureObserver;
};

/** The `window` the module under test installs its listeners on. */
interface FakeWindow {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  setTimeout(handler: () => void, ms: number): number;
}

/** A simulated page load: its own event handlers and pending timers. */
interface Page {
  fire(type: string, event: unknown): void;
  /** Run the timers the page scheduled — reloads are deferred by a delay. */
  flush(): void;
  /**
   * The hand-off `scheduleAutoReload` reports through: it is a module-level
   * callback the host installs, so a page that has not installed one can
   * still be observed reaching the branch.
   */
  sessionExpiries: Error[];
  /** Notices the page asked the host to show, in order; see `SessionFailure`. */
  notices: SessionFailure[];
  /** Every classified session failure the page reported, in order. */
  reported: SessionFailure[];
}

/**
 * One browser session: its `sessionStorage`, its clock and its reload count. A
 * page load re-imports `error-recovery.ts` with a cache-busting query so its
 * module-level state (`reloading`, `lastReloadAt`) starts fresh the way a real
 * reload resets it, while the storage and clock persist across loads — which is
 * exactly how the budget is meant to outlive a reload.
 */
interface Browser {
  /** Loads a page and returns it. */
  load(): Promise<Page>;
  /** Loads a page and returns its freshly-imported module, for the helpers. */
  loadModule(): Promise<RecoveryModule>;
  advance(ms: number): void;
  readonly reloads: number;
}

/** An in-memory `Storage`, complete so it needs no cast to stand in for one. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

/**
 * Install browser globals without casting `globalThis`: `defineProperty` takes
 * an `any` value, so the fakes are assigned on their own structural merits.
 */
function installGlobals(fakes: {
  sessionStorage: Storage;
  location: { reload(): void };
  window: FakeWindow;
}): void {
  for (const [name, value] of Object.entries(fakes)) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

function removeGlobals(): void {
  for (const name of ["sessionStorage", "location", "window"]) {
    Reflect.deleteProperty(globalThis, name);
  }
}

let instanceCounter = 0;
let nextLoadId = 0;

beforeEach(() => {
  instanceCounter += 1;
});

afterEach(() => {
  Date.now = realDateNow;
  removeGlobals();
});

const realDateNow = Date.now;

/** Install a fresh browser session. Call within a test that needs one. */
function createBrowser(): Browser {
  const storage = memoryStorage();
  const instance = instanceCounter;
  let clock = 1_700_000_000_000;
  let reloads = 0;

  const location = {
    reload: () => {
      reloads += 1;
    },
  };

  const load = async (): Promise<{ page: Page; module: RecoveryModule }> => {
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    const timers: Array<() => void> = [];
    const sessionExpiries: Error[] = [];
    const notices: SessionFailure[] = [];
    const reported: SessionFailure[] = [];

    installGlobals({
      sessionStorage: storage,
      location,
      window: {
        addEventListener: (type, handler) => {
          handlers.set(type, [...(handlers.get(type) ?? []), handler]);
        },
        setTimeout: (handler) => {
          timers.push(handler);
          return timers.length;
        },
      },
    });

    nextLoadId += 1;
    // Runtime-selected specifier on purpose: a static import would be cached
    // across loads, carrying `reloading`/`lastReloadAt` over and hiding exactly
    // the cross-load budget behavior under test.
    const module: RecoveryModule = await import(
      `./error-recovery.ts?browser=${instance}&load=${nextLoadId}`
    );
    module.installGlobalErrorRecovery();
    module.setSessionExpiryHandler((err) => {
      sessionExpiries.push(err as Error);
    });
    module.setSessionFailureNoticeHandler((failure) => {
      notices.push(failure);
    });
    module.setSessionFailureObserver((failure) => {
      reported.push(failure);
    });

    return {
      module,
      page: {
        sessionExpiries,
        notices,
        reported,
        fire(type, event) {
          for (const handler of handlers.get(type) ?? []) handler(event);
        },
        flush() {
          for (const timer of timers.splice(0)) timer();
        },
      },
    };
  };

  return {
    get reloads() {
      return reloads;
    },
    advance(ms) {
      clock += ms;
      Date.now = () => clock;
    },
    async load() {
      return (await load()).page;
    },
    async loadModule() {
      return (await load()).module;
    },
  };
}

/** A rejected dynamic import, as Vite's preload helper reports it. */
function staleChunk(): { payload: Error } {
  return {
    payload: new Error(
      "Failed to fetch dynamically imported module: " +
        "https://roomy.space/_app/immutable/nodes/23.B7E6DFpR.js",
    ),
  };
}

/**
 * A session failure with no cause the classifier can name: a PDS 401 carrying
 * no message it recognises. These still spend the shared reload budget and hand
 * off to the login path once it is gone — the behaviour the budget exists for.
 */
function unattributedSessionFailure(): Error {
  return Object.assign(new Error("getServiceAuth failed (401)"), {
    status: 401,
  });
}

/**
 * A dead OAuth session, as the OAuth client reports it. The refresh was
 * rejected, so the session is dead where it is held: worth one reload to
 * confirm it, not the whole shared budget.
 */
function refreshRejected(): Error {
  return Object.assign(new Error("could not renew session credentials"), {
    name: "TokenRefreshError",
  });
}

/**
 * The device's clock ahead of the server's, as the authorization server words
 * it. Every request the session layer signs is rejected, so nothing a reload
 * does can help: the clock has to be corrected.
 */
function dpopClockAhead(): Error {
  return Object.assign(new Error("DPoP proof iat is in the future"), {
    status: 401,
  });
}

/** The device's clock behind the server's: the proof arrived already stale. */
function dpopProofExpired(): Error {
  return Object.assign(new Error("DPoP proof expired"), { status: 401 });
}

/** A session another tab or process removed from the shared store. */
function sessionDeleted(): Error {
  return Object.assign(
    new Error("The session was deleted by another process"),
    { name: "TokenRefreshError", status: 401 },
  );
}

/** The deployed session layer's sentence: not in this repo, but the cause is ours to handle. */
function sessionExpired(): Error {
  return new Error("session expired, please re-authenticate");
}

/** A call made before a session exists (this app's own throw). */
function notAuthenticated(): Error {
  return new Error("Not authenticated");
}

describe("vite:preloadError recovery", () => {
  test("a stale chunk reloads the page once, after the flush delay", async () => {
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    page.fire("vite:preloadError", staleChunk());

    // Scheduled, not immediate — logs flush and events settle first.
    assert.equal(browser.reloads, 0);

    page.flush();
    assert.equal(browser.reloads, 1);
  });

  test("a burst of preload failures coalesces into a single reload", async () => {
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    page.fire("vite:preloadError", staleChunk());
    page.fire("vite:preloadError", staleChunk());
    page.fire("vite:preloadError", staleChunk());
    page.flush();

    assert.equal(browser.reloads, 1);
  });

  test("MAX_RELOADS bounds the reloads across page loads", async () => {
    const browser = createBrowser();
    browser.advance(0);

    // Each iteration is one reloaded document hitting the same stale chunk.
    for (let load = 0; load < MAX_RELOADS + 2; load += 1) {
      const page = await browser.load();
      page.fire("vite:preloadError", staleChunk());
      page.flush();
    }

    assert.equal(browser.reloads, MAX_RELOADS);
  });

  test("the preload trigger spends the ATProto trigger's budget", async () => {
    const browser = createBrowser();
    browser.advance(0);

    // Spend all but one reload through the other trigger, then show a stale
    // chunk spends the last one and is refused after that — one budget, not two
    // independent reload paths.
    for (let load = 0; load < MAX_RELOADS - 1; load += 1) {
      const page = await browser.load();
      page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
      page.flush();
    }
    assert.equal(browser.reloads, MAX_RELOADS - 1);

    const page = await browser.load();
    page.fire("vite:preloadError", staleChunk());
    page.flush();
    assert.equal(browser.reloads, MAX_RELOADS);

    const next = await browser.load();
    next.fire("vite:preloadError", staleChunk());
    next.flush();
    assert.equal(browser.reloads, MAX_RELOADS);
  });

  test("a user-driven navigation hands the budget back", async () => {
    const browser = createBrowser();
    browser.advance(0);

    for (let load = 0; load < MAX_RELOADS; load += 1) {
      const page = await browser.load();
      page.fire("vite:preloadError", staleChunk());
      page.flush();
    }
    assert.equal(browser.reloads, MAX_RELOADS);

    // A completed link navigation proves the asset graph resolves, so the
    // earlier reloads were deploy skew, not a loop: stale chunks may reload
    // again instead of leaving the user stuck for the rest of the window.
    const module = await browser.loadModule();
    module.noteSuccessfulNavigation("link");

    const next = await browser.load();
    next.fire("vite:preloadError", staleChunk());
    next.flush();
    assert.equal(browser.reloads, MAX_RELOADS + 1);
  });

  test("hydration does not hand the budget back", async () => {
    const browser = createBrowser();
    browser.advance(0);

    // `enter` fires on every page load, including the one a reload produces.
    // Refilling on it would let a client that a reload cannot fix reload
    // forever — the loop MAX_RELOADS exists to stop.
    for (let load = 0; load < MAX_RELOADS; load += 1) {
      const page = await browser.load();
      page.fire("vite:preloadError", staleChunk());
      page.flush();
    }
    assert.equal(browser.reloads, MAX_RELOADS);

    for (let load = 0; load < 2; load += 1) {
      const module = await browser.loadModule();
      module.noteSuccessfulNavigation("enter");

      const page = await browser.load();
      page.fire("vite:preloadError", staleChunk());
      page.flush();
    }
    assert.equal(browser.reloads, MAX_RELOADS);
  });

  test("the budget is keyed to the sliding window", async () => {
    const browser = createBrowser();
    browser.advance(0);

    for (let load = 0; load < MAX_RELOADS; load += 1) {
      const page = await browser.load();
      page.fire("vite:preloadError", staleChunk());
      page.flush();
    }
    assert.equal(browser.reloads, MAX_RELOADS);

    // Past the window the recorded reloads expire, so a later genuine deploy
    // skew is not refused on the strength of ancient history.
    browser.advance(WINDOW_MS + 1);
    const page = await browser.load();
    page.fire("vite:preloadError", staleChunk());
    page.flush();
    assert.equal(browser.reloads, MAX_RELOADS + 1);
  });

  test("an unrelated error still does not reload", async () => {
    // The preload handler must not have widened the trigger: an appserver XRPC
    // failure or a resource error has no reload recovery.
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    page.fire("error", {
      error: new Error("space.roomy.room.getMessages failed: 500"),
    });
    page.fire("unhandledrejection", { reason: new Error("Forbidden") });
    page.flush();

    assert.equal(browser.reloads, 0);
  });

  test("the budget is persisted where a reload can find it", async () => {
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    assert.equal(globalThis.sessionStorage.getItem(STORAGE_KEY), null);

    page.fire("vite:preloadError", staleChunk());
    page.flush();

    // Recorded in sessionStorage (survives the reload; cleared when the tab
    // closes) rather than in module state, which a reload would reset.
    const recorded: unknown = JSON.parse(
      globalThis.sessionStorage.getItem(STORAGE_KEY) ?? "null",
    );
    assert.ok(Array.isArray(recorded));
    assert.equal(recorded.length, 1);
  });
});

/**
 * The hand-off is per *spend of the budget*, not per tab: it fires once, and
 * the document it lands in owns a clean budget. `logout()` signs the session
 * out and reloads, which both ends the reason the reloads were being refused
 * and leaves the login path in charge. So the hand-off appears in exactly one
 * page load, and the next load is an ordinary signed-out one.
 *
 * The failures here are ones the classifier cannot name. A *named* dead session
 * never reaches this branch: it gets one reload and then a notice (see "session
 * failures by cause"), because signing the user out is the last resort and the
 * cause is what tells them what happened.
 */
describe("the reload budget, once spent", () => {
  /** Spend the budget from a failure the module's own trigger recognises. */
  async function spendBudget(browser: Browser): Promise<void> {
    for (let load = 0; load < MAX_RELOADS; load += 1) {
      const page = await browser.load();
      page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
      page.flush();
    }
  }
  /** The document `logout()` reloads into, once the budget has been spent. */
  async function spendAndHandOff(browser: Browser): Promise<Page> {
    await spendBudget(browser);
    const page = await browser.load();
    page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
    page.flush();
    assert.equal(page.sessionExpiries.length, 1);
    return page;
  }

  test("an unattributed session failure hands off to the login path instead of looping", async () => {
    const browser = createBrowser();
    browser.advance(0);
    await spendBudget(browser);
    assert.equal(browser.reloads, MAX_RELOADS);

    const page = await browser.load();
    page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
    page.flush();

    // No further reload — the budget said so — and no silence either: the
    // recovery action is the hand-off the host registered, which is what takes
    // the user to a login prompt.
    assert.equal(browser.reloads, MAX_RELOADS);
    assert.equal(page.sessionExpiries.length, 1);
  });

  test("one failing session hands off once, however many callers report it", async () => {
    const browser = createBrowser();
    browser.advance(0);
    await spendBudget(browser);

    // One dead session surfaces through every failed query, the profile fetch
    // and the push re-subscribe. Each is the same failure and is already being
    // acted on.
    const page = await browser.load();
    for (let i = 0; i < 5; i += 1) {
      page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
      page.fire("error", { error: unattributedSessionFailure() });
    }
    page.flush();

    assert.equal(page.sessionExpiries.length, 1);
    assert.equal(browser.reloads, MAX_RELOADS);
  });

  test("a spent budget still refuses a stale chunk without handing off", async () => {
    // The budget is shared, but the outcome is not: a stale chunk is
    // transient, so spending the budget on one must not sign the user out.
    const browser = createBrowser();
    browser.advance(0);
    await spendBudget(browser);

    const page = await browser.load();
    page.fire("vite:preloadError", staleChunk());
    page.flush();

    assert.equal(browser.reloads, MAX_RELOADS);
    assert.equal(page.sessionExpiries.length, 0);
  });

  test("a fresh budget reloads instead of handing off", async () => {
    // The hand-off belongs to the exhausted branch alone: while reloads
    // remain, a session failure is still retried by reload, not given up on.
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
    page.flush();

    assert.equal(browser.reloads, 1);
    assert.equal(page.sessionExpiries.length, 0);
  });

  test("the hand-off is not itself a loop: the landing document has a clean budget", async () => {
    // `logout()` reloads into the same tab, so the next document would find the
    // exhaustion branch again. If that handed off again, the app would log out
    // and reload forever — the loop the budget exists to stop, merely renamed.
    // It does not: the landing document owns a whole budget again.
    const browser = createBrowser();
    browser.advance(0);
    await spendAndHandOff(browser);

    const afterHandOff = await browser.load();
    afterHandOff.fire("unhandledrejection", {
      reason: unattributedSessionFailure(),
    });
    afterHandOff.flush();

    assert.equal(browser.reloads, MAX_RELOADS + 1);
    assert.equal(afterHandOff.sessionExpiries.length, 0);
  });

  test("a navigation the user drove can hand off again", async () => {
    // The login affordances reset the budget by hand, so a session that dies
    // again after the user asked to start over is handled rather than ignored.
    const browser = createBrowser();
    browser.advance(0);
    await spendAndHandOff(browser);

    const module = await browser.loadModule();
    module.noteSuccessfulNavigation("link");

    await spendBudget(browser);
    const page = await browser.load();
    page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
    page.flush();

    assert.equal(page.sessionExpiries.length, 1);
  });
});

/**
 * The appserver error shape built by `DirectXrpcClient`'s `toXrpcError`: the
 * message comes from the response body, and `nsid` records the XRPC call that
 * produced it.
 */
function appserverUnauthorized(): Error {
  return Object.assign(
    new Error(
      "XRPC space.roomy.getFlags failed (401): Authentication required",
    ),
    { status: 401, errorType: "AuthRequired", nsid: "space.roomy.getFlags" },
  );
}

/**
 * The cause every fixture reports, in the order the classifier checks them. The
 * five causes the user can act on differently are the point: a wrong clock, a
 * session deleted elsewhere, a refused refresh, an expired session and a call
 * with no session at all used to reach the recovery path as the same 401.
 */
describe("classifySessionFailure", () => {
  const causes: Array<[string, () => unknown, string]> = [
    ["a device clock ahead of the server", dpopClockAhead, "dpop-clock-ahead"],
    ["a device clock behind the server", dpopProofExpired, "dpop-proof-expired"],
    ["a session deleted by another process", sessionDeleted, "session-deleted"],
    [
      "the session layer's expired-session sentence",
      sessionExpired,
      "session-expired",
    ],
    ["a call made before a session exists", notAuthenticated, "session-absent"],
    ["a refused token refresh", refreshRejected, "refresh-401"],
    ["a session failure with no readable cause", unattributedSessionFailure, "none"],
  ];

  for (const [name, err, cause] of causes) {
    test(`${name} is named, or left unnamed when nothing names it`, () => {
      const failure = classifySessionFailure(err());
      assert.equal(failure?.cause ?? "none", cause);
    });
  }

  test("a DPoP clock failure is not recoverable by a reload", () => {
    // A reload re-runs session restore against the same clock. It was reached
    // as "recoverable" only because it is a bare 401, and the recovery it earned
    // was three reloads and a sign-out — the failure this classification exists
    // to stop.
    assert.equal(isRecoverableAtprotoError(dpopClockAhead()), false);
    assert.equal(
      classifySessionFailure(dpopClockAhead())?.disposition,
      "notice",
    );

    // The same, for the proof that arrived stale.
    assert.equal(isRecoverableAtprotoError(dpopProofExpired()), false);
    assert.equal(
      classifySessionFailure(dpopProofExpired())?.disposition,
      "notice",
    );
  });

  test("an appserver XRPC 401 names no session failure", () => {
    // A per-resource authorization failure carries an `nsid` and is not a dead
    // session: it must stay unnamed, and stay unrecoverable.
    assert.equal(classifySessionFailure(appserverUnauthorized()), null);
    assert.equal(isRecoverableAtprotoError(appserverUnauthorized()), false);
  });

  test("a session-layer failure keeps its cause through an XRPC wrapper", () => {
    // The deployed layer's sentence arrives with the XRPC nsid attached when the
    // call was proxied. The cause outranks the nsid guard: the session is dead
    // for the same reason it would be on a bare fetch.
    const proxied = Object.assign(
      new Error("XRPC space.roomy.user.getProfile failed (401): session expired, please re-authenticate"),
      { status: 401, nsid: "space.roomy.user.getProfile" },
    );
    assert.equal(classifySessionFailure(proxied)?.cause, "session-expired");
  });
});

/** The cause a log line carried, from the structured field the call sites append. */
function loggedCause(args: unknown[]): string | undefined {
  const fields = args[2];
  if (fields == null || typeof fields !== "object" || !("cause" in fields)) {
    return undefined;
  }
  return typeof fields.cause === "string" ? fields.cause : undefined;
}

describe("session failures by cause", () => {
  test("the clock failure shows the notice and spends no reload", async () => {
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    page.fire("unhandledrejection", { reason: dpopClockAhead() });
    page.flush();

    // No reload, no sign-out: neither could change the device's clock.
    assert.equal(browser.reloads, 0);
    assert.equal(page.sessionExpiries.length, 0);
    // The notice is the whole recovery, and it names the cause.
    assert.deepEqual(
      page.notices.map((notice) => notice.cause),
      ["dpop-clock-ahead"],
    );
  });

  test("the clock notice leaves the reload budget for the failures it can fix", async () => {
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();
    page.fire("unhandledrejection", { reason: dpopClockAhead() });
    page.flush();

    // A stale chunk after the clock failure still owns the full budget.
    for (let load = 0; load < MAX_RELOADS; load += 1) {
      const next = await browser.load();
      next.fire("vite:preloadError", staleChunk());
      next.flush();
    }
    assert.equal(browser.reloads, MAX_RELOADS);
  });

  test("a clock failure reported by every failed request notifies once", async () => {
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    // One wrong clock fails every query, the profile fetch and the sync socket
    // at once; they are one failure to the user.
    for (let i = 0; i < 8; i += 1) {
      page.fire("unhandledrejection", { reason: dpopClockAhead() });
    }
    page.flush();

    assert.equal(page.notices.length, 1);
    assert.equal(browser.reloads, 0);
  });

  test("a dead session spends one reload, then shows the notice with its cause", async () => {
    const browser = createBrowser();
    browser.advance(0);

    const first = await browser.load();
    first.fire("unhandledrejection", { reason: refreshRejected() });
    first.flush();
    assert.equal(browser.reloads, 1);
    assert.equal(first.notices.length, 0);

    // The reloaded document finds the session still dead. One reload was the
    // budget this failure is worth: the second document shows the cause and the
    // way to sign in instead of retrying a third and fourth time.
    const second = await browser.load();
    second.fire("unhandledrejection", { reason: refreshRejected() });
    second.flush();

    assert.equal(browser.reloads, 1);
    assert.equal(second.sessionExpiries.length, 0);
    assert.deepEqual(
      second.notices.map((notice) => notice.cause),
      ["refresh-401"],
    );
  });

  test("a session deleted elsewhere is one reload too, under its own cause", async () => {
    const browser = createBrowser();
    browser.advance(0);

    const first = await browser.load();
    first.fire("unhandledrejection", { reason: sessionDeleted() });
    first.flush();
    assert.equal(browser.reloads, 1);

    const second = await browser.load();
    second.fire("unhandledrejection", { reason: sessionDeleted() });
    second.flush();

    assert.equal(browser.reloads, 1);
    assert.deepEqual(
      second.notices.map((notice) => notice.cause),
      ["session-deleted"],
    );
  });

  test("a call with no session is recorded and otherwise left alone", async () => {
    // Before a session exists, every startup query throws "Not authenticated".
    // That is the login path's normal state: no reload (it would loop) and no
    // notice (the sign-in screen is already up), but the corpus still counts it.
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    for (let i = 0; i < 3; i += 1) {
      page.fire("unhandledrejection", { reason: notAuthenticated() });
    }
    page.flush();

    assert.equal(browser.reloads, 0);
    assert.equal(page.notices.length, 0);
    assert.deepEqual(
      page.reported.map((failure) => failure.cause),
      ["session-absent"],
    );
  });

  test("every session failure reaches the observer with its cause", async () => {
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    page.fire("unhandledrejection", { reason: dpopClockAhead() });
    page.fire("unhandledrejection", { reason: sessionExpired() });
    page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
    page.flush();

    assert.deepEqual(
      page.reported.map((failure) => failure.cause),
      ["dpop-clock-ahead", "session-expired", "unattributed"],
    );
  });

  test("every session-failure log line carries its cause", async () => {
    const browser = createBrowser();
    browser.advance(0);
    const page = await browser.load();

    const lines: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      page.fire("unhandledrejection", { reason: dpopClockAhead() });
      page.fire("unhandledrejection", { reason: unattributedSessionFailure() });
      page.flush();
    } finally {
      console.warn = realWarn;
    }

    // The clock line reports no reload, with the cause attached; the
    // unattributed one reloads, with its label attached.
    const causes = lines.map(loggedCause);
    assert.ok(causes.includes("dpop-clock-ahead"));
    assert.ok(causes.includes("unattributed"));
  });
});
