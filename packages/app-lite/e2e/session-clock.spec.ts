/**
 * A device clock the server rejects is named, not reloaded away.
 *
 * The authorization server rejects a DPoP proof whose `iat` is later than its
 * own clock plus a tolerance window — `DPoP proof iat is in the future` — and
 * every request the session layer signs fails the same way. A reload cannot
 * change the device's clock, so the three reloads this failure used to spend
 * were known-futile before the first one, and the spend ended in a sign-out with
 * no explanation.
 *
 * What runs for real here: the page's own clock, skewed five minutes ahead in
 * `addInitScript` before any application code loads, so every timestamp the
 * client produces — and every proof it would sign — is five minutes in the
 * future. The stub PDS stands in for the authorization server's rejection of
 * that proof: it cannot verify a DPoP signature, and the app-password auth path
 * this harness uses sends no DPoP header, so it answers with the body the real
 * server computes from a skewed proof.
 *
 * What the spec pins is the recovery decision: the clock notice, no automatic
 * reload, no hand-off to the login path, and none of the reload budget touched.
 * The budget keys are the observable — `scheduleReload` records an attempt and
 * the hand-off in `sessionStorage`, which outlives any reload, so a page that
 * never reloaded has neither.
 */

import { expect, test } from "./spec-helpers.ts";
import { PDS_ORIGIN } from "./fixtures.ts";

/** The skew the client is given; the server's tolerance is well under a minute. */
const SKEW_MS = 5 * 60_000;
/** Six times the 600 ms reload delay: long enough that a reload would have happened. */
const QUIET_MS = 4_000;

const AUTO_RELOAD_KEY = "roomy:autoReload";
const SESSION_RECOVERY_KEY = "roomy:sessionRecoveryReload";
const HAND_OFF_KEY = "roomy:sessionExpiryHandOff";

test.describe("a device clock the server rejects", () => {
  test("shows the clock notice, reloads nothing and signs nobody out", async ({
    page,
  }) => {
    // The device's clock, five minutes fast — set before the bundle runs, so
    // the app's `init()` and every proof it signs afterwards are skewed too.
    await page.addInitScript((skew) => {
      const realNow = Date.now;
      Date.now = () => realNow() + skew;
    }, SKEW_MS);

    await page.route(`${PDS_ORIGIN}/**`, async (route) => {
      const url = route.request().url();
      if (url.includes("com.atproto.server.getServiceAuth")) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({
            error: "InvalidDpopProof",
            message: "DPoP proof iat is in the future",
          }),
        });
      }
      return route.continue();
    });

    let loads = 0;
    page.on("load", () => loads++);

    await page.goto("/");

    // The notice names the clock, in the user's terms, with a reload affordance.
    // Scoped by text: the sortable list library also renders a `role="alert"`
    // status node, which is not this notice.
    const notice = page
      .getByRole("alert")
      .filter({ hasText: /device clock is ahead/i });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText(/device clock is ahead/i);
    await expect(notice.getByRole("button", { name: "Reload" })).toBeVisible();
    // Nothing to sign in for: the session is intact, only its proofs are refused.
    await expect(page.getByRole("button", { name: "Sign in again" })).toHaveCount(0);

    // Quiet for six reload delays: the reload path was never taken.
    await page.waitForTimeout(QUIET_MS);
    expect(loads).toBe(1);

    const records = await page.evaluate(
      ([autoKey, recoveryKey, handOffKey]) => ({
        autoReload: sessionStorage.getItem(autoKey!),
        sessionRecovery: sessionStorage.getItem(recoveryKey!),
        handOff: sessionStorage.getItem(handOffKey!),
      }),
      [AUTO_RELOAD_KEY, SESSION_RECOVERY_KEY, HAND_OFF_KEY],
    );
    expect(records).toEqual({
      autoReload: null,
      sessionRecovery: null,
      handOff: null,
    });
  });
});
