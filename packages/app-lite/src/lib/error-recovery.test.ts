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
import type {
  installGlobalErrorRecovery,
  noteSuccessfulNavigation,
} from "./error-recovery.ts";

/** The documented budget. Not exported; pinned here as observable behavior. */
const MAX_RELOADS = 3;
/** The sliding window the budget is recorded within. */
const WINDOW_MS = 60_000;

const STORAGE_KEY = "roomy:autoReload";

type RecoveryModule = {
  installGlobalErrorRecovery: typeof installGlobalErrorRecovery;
  noteSuccessfulNavigation: typeof noteSuccessfulNavigation;
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

    return {
      module,
      page: {
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

/** A recoverable ATProto session failure — the other trigger on this path. */
function deadSession(): Error {
  return Object.assign(new Error("token refresh failed"), {
    name: "TokenRefreshError",
  });
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
      page.fire("unhandledrejection", { reason: deadSession() });
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
