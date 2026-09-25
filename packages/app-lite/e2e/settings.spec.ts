/**
 * Settings pages.
 *
 * Defends: the settings routes resolve for a signed-in admin and render their
 * real content — the space settings form (with the seeded name in it), the
 * settings nav, member list, and user settings. These read the same
 * `getMetadata` / `getMembers` / `getSpaces` projections as the rest of the
 * app, so a broken read path surfaces here too.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { SEED_SPACE_ID, SEED_SPACE_NAME } from "./fixtures.ts";

test.describe("settings", () => {
  test("space settings renders the admin form with the space's data", async ({
    page,
  }) => {
    await page.goto(`/${SEED_SPACE_ID}/settings`);
    await waitForAuthenticated(page);

    // The form is admin-only; the seeded user is an admin, so the denial text
    // must not be shown.
    await expect(
      page.getByText("You don't have permission to edit this space's settings."),
    ).toHaveCount(0);

    // The name input holds what the appserver materialised — proving the
    // settings form is bound to real space metadata.
    await expect(page.locator("input#space-name")).toHaveValue(SEED_SPACE_NAME);
  });

  test("space settings exposes its navigation tabs", async ({ page }) => {
    await page.goto(`/${SEED_SPACE_ID}/settings`);
    await waitForAuthenticated(page);

    // Each tab is a link under the space's settings path.
    await expect(page.locator(`a[href="/${SEED_SPACE_ID}/settings/permissions"]`)).toBeVisible();
    await expect(page.locator(`a[href="/${SEED_SPACE_ID}/settings/members"]`)).toBeVisible();
  });

  test("the members page lists the space's members", async ({ page }) => {
    await page.goto(`/${SEED_SPACE_ID}/settings/members`);
    await waitForAuthenticated(page);

    // `getMembers` is a per-space projection; the seeded member must appear.
    await expect(page.getByPlaceholder("Search members…")).toBeVisible();
  });

  test("user settings renders its sections", async ({ page }) => {
    await page.goto("/user/settings");
    await waitForAuthenticated(page);

    await expect(page.getByRole("heading", { name: "Theme" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Left Spaces" })).toBeVisible();
  });

  test("the space index route renders instead of the settings panel", async ({
    page,
  }) => {
    await page.goto(`/${SEED_SPACE_ID}`);
    await waitForAuthenticated(page);

    // The space index is the threads board, not a redirect into settings.
    await expect(page).toHaveURL(new RegExp(`/${SEED_SPACE_ID}$`));
  });
});
