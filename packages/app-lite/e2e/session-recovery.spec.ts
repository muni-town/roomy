/**
 * A dead session still auto-reloads.
 *
 * The stale-data handling added alongside this spec keeps a failed *revalidation*
 * on screen and reports it non-fatally, which raises the question of where the
 * line is: a session that can no longer mint a service-auth token fails every
 * query the same way, and a reload is the one thing that can fix it. That path
 * belongs to `error-recovery.ts` and is unchanged — this spec is what keeps it
 * that way.
 *
 * The failure is driven from the stub PDS: `getServiceAuth` answers 401 with no
 * `nsid`, which is the PDS-level session failure `isRecoverableAtprotoError`
 * treats as recoverable (an appserver XRPC 401 carries an `nsid` and is
 * per-resource, so it must NOT reload). `createSession` is left alone, so the
 * app authenticates and then fails on the first XRPC call's token fetch.
 *
 * The budget key is the observable: `scheduleReload` writes the attempt before
 * reloading, and `sessionStorage` outlives the reload — so a page that never
 * reloaded has no entry, and one that did has it even after the reload.
 */

import { expect, test } from "./spec-helpers.ts";
import { PDS_ORIGIN } from "./fixtures.ts";

test.describe("a recoverable session failure", () => {
  test("reloads the page instead of staying on stale data", async ({ page }) => {
    await page.route(`${PDS_ORIGIN}/**`, async (route) => {
      const url = route.request().url();
      if (url.includes("com.atproto.server.getServiceAuth")) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: "AuthenticationRequired",
            message: "Authentication required",
          }),
        });
      }
      return route.continue();
    });

    let loads = 0;
    page.on("load", () => loads++);

    await page.goto("/");

    // The reload is deliberate and delayed (600 ms) — and the app re-attempts,
    // so what is asserted is that it happened at all, not how often.
    await expect
      .poll(() => loads, { timeout: 60_000, message: "page reloaded" })
      .toBeGreaterThan(1);

    const budget = await page.evaluate(() =>
      sessionStorage.getItem("roomy:autoReload"),
    );
    const attempts = JSON.parse(budget ?? "[]") as unknown[];
    expect(attempts.length).toBeGreaterThan(0);
  });
});
