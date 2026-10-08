/**
 * A dead session must not settle into a console-error loop.
 *
 * Defends the branch in `error-recovery.ts` that runs once the auto-reload
 * budget is spent *on a session failure*: the client stops reloading and hands
 * off to the login path, rather than logging the refusal and staying put with
 * a dead session and no way forward.
 *
 * The credential store is made invalid the only way a hermetic run can: the
 * PDS refuses `createSession`, so every document's attempt to establish a
 * session fails the way an expired one does. This runs in `PUBLIC_TEST_*`
 * (app-password) auth, which has no session store to expire — the refusal is
 * the same observable failure, and exercises the same trigger, budget and
 * hand-off. The OAuth client's own `TokenRefreshError` reaches
 * `scheduleAutoReload` through the same public entry point.
 */

import type { Page } from "@playwright/test";

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { PDS_ORIGIN, TEST_USER_DID } from "./fixtures.ts";

/** The documented budget. Not exported; pinned here as observable behavior. */
const MAX_RELOADS = 3;
/** Eight times the 600ms reload delay: long enough that a loop would have moved. */
const QUIET_MS = 5_000;

const AUTO_RELOAD_KEY = "roomy:autoReload";
const HAND_OFF_KEY = "roomy:sessionExpiryHandOff";

/**
 * Refuse every sign-in attempt from this point on. The page already holds a
 * session from the initial load; the next document cannot establish one.
 */
async function refuseSignIn(page: Page): Promise<void> {
  await page.route(`${PDS_ORIGIN}/**`, async (route) => {
    if (!route.request().url().includes("createSession")) {
      await route.continue();
      return;
    }
    // The shape `AtpAgent.login()` fails on, and the one the app's classifier
    // reads as recoverable: a 401 whose message names the dead credential.
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        error: "AuthenticationRequired",
        message: "Invalid identifier or password",
      }),
    });
  });
}

interface RecoveryState {
  /** Reloads recorded in the current sliding window. */
  reloads: number;
  /** Set once a spent budget has handed off; see `error-recovery.ts`. */
  handOff: string | null;
}

/**
 * The tab's own records. `null` while a reload is in flight and the execution
 * context is gone — a "keep waiting", not a failure.
 */
async function readState(page: Page): Promise<RecoveryState | null> {
  try {
    return await page.evaluate(
      ([autoKey, handOffKey]) => ({
        reloads: JSON.parse(sessionStorage.getItem(autoKey!) ?? "[]").length,
        handOff: sessionStorage.getItem(handOffKey!),
      }),
      [AUTO_RELOAD_KEY, HAND_OFF_KEY],
    );
  } catch {
    return null;
  }
}

/**
 * The document `logout()` reloads into: signed out, and — because the hand-off
 * releases the budget with the session — an ordinary one again.
 */
function hasHandedOff(state: RecoveryState | null): boolean {
  return state !== null && state.handOff !== null && state.reloads === 0;
}

test.describe("a dead session with no reloads left", () => {
  test("stops reloading and hands off instead of looping", async ({ page }) => {
    const recovery: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[error-recovery]")) recovery.push(text);
    });

    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });

    await page.goto("/");
    await waitForAuthenticated(page);

    await refuseSignIn(page);
    await page.reload({ waitUntil: "domcontentloaded" });

    // The hand-off lands the user in a document with no session and a whole
    // budget. Polling to that state is the deterministic read of it; no
    // wall-clock assumption about how long the reloads take.
    await expect
      .poll(async () => hasHandedOff(await readState(page)), {
        timeout: 30_000,
        message: "the exhausted budget should hand off to the login path",
      })
      .toBe(true);

    // Console lines are append-only, so these are the whole record: the budget
    // spent exactly as documented, then one hand-off, and no second one. A
    // client still looping would have logged a fourth reload or a repeat.
    expect(recovery.filter((l) => l.includes("reloading page in"))).toHaveLength(
      MAX_RELOADS,
    );
    expect(recovery.filter((l) => l.includes("handing off"))).toHaveLength(1);
    expect(recovery.filter((l) => l.includes("not repeating it"))).toEqual([]);

    // And nothing is still pending: the page has stopped moving.
    const settled = navigations;
    await page.waitForTimeout(QUIET_MS);
    expect(navigations).toBe(settled);
  });

  test("signs the user out, so the next document owns a whole budget", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAuthenticated(page);
    await expect(
      page.locator(`a[href="/user/${TEST_USER_DID}"]`).first(),
    ).toBeVisible();

    await refuseSignIn(page);
    await page.reload({ waitUntil: "domcontentloaded" });

    // `hasHandedOff` also pins the released budget: the landing document
    // records no reloads, so the hand-off cannot itself become the loop.
    await expect
      .poll(async () => hasHandedOff(await readState(page)), { timeout: 30_000 })
      .toBe(true);

    // The signed-in shell is gone: the session the client kept failing against
    // has been signed out, not left in place behind an error.
    await expect(
      page.locator(`a[href="/user/${TEST_USER_DID}"]`),
    ).toHaveCount(0);
  });
});
