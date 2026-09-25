/**
 * App shell and authentication.
 *
 * Defends: the app boots, authenticates through the real client auth path
 * against the stub PDS, resolves the caller against the appserver, and renders
 * the authenticated shell with the signed-in user — i.e. the whole
 * client → auth → appserver chain works. If any link breaks (client auth,
 * `X-Test-Did` wiring, session setup, profile fetch) these fail.
 */

import {
  composer,
  expect,
  test,
  waitForAuthenticated,
} from "./spec-helpers.ts";
import {
  SEED_ROOM_PATH,
  TEST_USER_DID,
  TEST_USER_DISPLAY_NAME,
} from "./fixtures.ts";

test.describe("app shell and authentication", () => {
  test("authenticates and renders the signed-in user", async ({ page }) => {
    await page.goto("/");

    // No login affordance: the app auto-authenticated via the test-mode path.
    await expect(page.getByText("Sign into your account.")).toHaveCount(0);

    await waitForAuthenticated(page);

    // The user card shows the profile the appserver returned for this DID —
    // proving the appserver resolved the caller from the injected header and
    // the profile query round-tripped, not merely that the app rendered.
    await expect(page.getByText(TEST_USER_DISPLAY_NAME)).toBeVisible();
  });

  test("loads a space's channel and exposes the composer", async ({ page }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // The composer is the app's main write surface; its presence means the
    // room route resolved, the user has write access, and the editor mounted.
    await expect(composer(page)).toBeVisible();

    // The room page is titled by the channel's materialised name.
    await expect(page.getByText("lobby").first()).toBeVisible();
  });

  test("reports no client-side errors while loading the app", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(composer(page)).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("keeps the signed-in identity across a reload", async ({ page }) => {
    await page.goto("/");
    await waitForAuthenticated(page);

    await page.reload();
    await waitForAuthenticated(page);

    // Same DID after a reload: the session survived, rather than the app
    // silently falling back to a logged-out shell.
    await expect(page.locator(`a[href="/user/${TEST_USER_DID}"]`)).toBeVisible();
  });
});
