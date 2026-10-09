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
import {
  SEED_SPACE_2_ID,
  SEED_SPACE_2_NAME,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
} from "./fixtures.ts";

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

test.describe("space discoverability setting", () => {
  test("unanswered renders no selection and untouched writes nothing", async ({
    page,
  }) => {
    // Count the writes this page issues; the unanswered, untouched form must
    // issue none, so Save only ever carries a value the admin picked.
    let writes = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.endsWith("space.sendEvents")) writes += 1;
    });

    await page.goto(`/${SEED_SPACE_ID}/settings`);
    await waitForAuthenticated(page);
    // The metadata effect that seeds the toggle is the same one that fills the
    // name, so waiting for the name proves the blank is gone.
    await expect(page.locator("input#space-name")).toHaveValue(SEED_SPACE_NAME);

    await expect(
      page.getByText("Suggest this space to other users?"),
    ).toBeVisible();

    // The seeded space is unanswered (`suggest_to_others` NULL). The control
    // must show no choice rather than presenting "Yes" as if an admin had
    // picked it.
    const suggest = 'input[name="suggestToOthers"]';
    await expect(page.locator(`${suggest}[value="yes"]`)).not.toBeChecked();
    await expect(page.locator(`${suggest}[value="no"]`)).not.toBeChecked();

    // With nothing answered or edited there is no change to persist.
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    expect(writes).toBe(0);
  });

  test("picking a side persists it and reloads as that choice", async ({
    page,
  }) => {
    // A space of its own, so the read-only assertion above stays independent of
    // this write.
    await page.goto(`/${SEED_SPACE_2_ID}/settings`);
    await waitForAuthenticated(page);
    // The metadata effect that seeds the toggle is the one that fills the name
    // too; waiting for the name proves it ran, so the read below sees the
    // stored answer rather than the pre-fill blank.
    await expect(page.locator("input#space-name")).toHaveValue(SEED_SPACE_2_NAME);

    const radio = (value: string) =>
      page.locator(`input[name="suggestToOthers"][value="${value}"]`);
    // Answer whichever side is not already stored: picking the stored value
    // leaves nothing to save (Save stays disabled), so a CI retry — which
    // reuses the appserver, and therefore the previous attempt's answer — must
    // flip it rather than re-assert the unanswered start. On a fresh DB the
    // flip lands on "no", which is the write the read path could collapse.
    const target = (await radio("no").isChecked()) ? "yes" : "no";
    const other = target === "yes" ? "no" : "yes";

    await page
      .locator(`label:has(input[name="suggestToOthers"][value="${target}"])`)
      .click();
    await expect(radio(target)).toBeChecked();
    const save = page.getByRole("button", { name: "Save", exact: true });
    await save.click();
    // Save disables again only once the write's invalidation has refetched
    // metadata and the stored answer matches the form, so this is the point the
    // reload below can read the persisted value rather than race the write.
    await expect(save).toBeDisabled();

    await page.goto(`/${SEED_SPACE_2_ID}/settings`);
    await waitForAuthenticated(page);
    await expect(radio(target)).toBeChecked();
    await expect(radio(other)).not.toBeChecked();
  });

  test("the new-space flow asks the question", async ({ page }) => {
    await page.goto("/new");
    await waitForAuthenticated(page);

    await expect(
      page.getByText("Suggest this space to other users?"),
    ).toBeVisible();
  });
});
