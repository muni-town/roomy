/**
 * The user Access settings page is gated behind the `access-settings` feature
 * flag while progressive scope expansion is iterated on.
 *
 * Defends both halves of the gate, on the client predicate that reads
 * `space.roomy.getFlags`:
 *   - flag on  → the "Access" sidebar entry is present and the page renders
 *                its real capability rows (from `getScopeSettings`).
 *   - flag off → the sidebar entry is gone, and direct navigation to the route
 *                still lands on a gated notice rather than the capability UI.
 *
 * The seed enables the flag globally (see `seed.ts`), so the flag-on case runs
 * against the real projection. The flag-off case rewrites the `getFlags`
 * response for the page — the same value the client predicate consumes — so the
 * test needs no admin allowlist and stays hermetic.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { APPSERVER_HTTP_ORIGIN, TEST_USER_DID } from "./fixtures.ts";

/** Serve `getFlags` with `access-settings` removed, before navigation. */
async function withoutAccessSettingsFlag(page: Page): Promise<void> {
  await page.route(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.getFlags*`,
    async (route) => {
      // `route.fetch()` bypasses the base fixture's `X-Test-Did` injection, so
      // re-assert it here — the appserver's test-mode verifier reads that
      // header, and without it this 401s.
      const res = await route.fetch({
        headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
      });
      const body = (await res.json()) as { flags?: string[] };
      const flags = (body.flags ?? []).filter((f) => f !== "access-settings");
      await route.fulfill({ response: res, json: { flags } });
    },
  );
}

test.describe("access-settings flag", () => {
  test("flag on: the Access entry and page render", async ({ page }) => {
    await page.goto("/user/settings");
    await waitForAuthenticated(page);

    const accessLink = page.locator('a[href="/user/settings/scopes"]');
    await expect(accessLink).toBeVisible();

    await accessLink.click();
    await expect(page).toHaveURL(/\/user\/settings\/scopes$/);
    // The page's own heading proves the real body rendered, not the gate.
    await expect(page.getByText("Data access")).toBeVisible();
    await expect(page.getByText("Access settings are not enabled")).toHaveCount(
      0,
    );
  });

  test("flag off: no Access entry, and direct navigation shows the gate", async ({
    page,
  }) => {
    await withoutAccessSettingsFlag(page);

    await page.goto("/user/settings");
    await waitForAuthenticated(page);

    // The sidebar entry is hidden while the flag is off.
    await expect(page.locator('a[href="/user/settings/scopes"]')).toHaveCount(0);

    // Direct navigation still reaches the route, and it shows the gate
    // rather than the capability rows.
    await page.goto("/user/settings/scopes");
    await expect(page.getByText("Access settings are not enabled")).toBeVisible();
    await expect(page.getByText("Data access")).toHaveCount(0);
  });
});
