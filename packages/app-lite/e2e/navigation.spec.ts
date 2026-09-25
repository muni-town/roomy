/**
 * Space list and room navigation.
 *
 * Defends: the seeded space and its channel are materialised and visible, and
 * navigating into them renders that room's data. If `getSpaces`, the sidebar
 * assembly (`getMetadata`), or the room route's read path breaks, these fail.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  SEED_ROOM_ID,
  SEED_ROOM_NAME,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
} from "./fixtures.ts";

test.describe("space list and room navigation", () => {
  test("lists the joined space in the sidebar", async ({ page }) => {
    await page.goto("/");
    await waitForAuthenticated(page);

    // The space switcher renders one button per joined space, titled by name.
    const spaceButton = page.locator(
      `.space-switcher button[title="${SEED_SPACE_NAME}"]`,
    );
    await expect(spaceButton).toBeVisible();
  });

  test("navigating into the space shows its channel", async ({ page }) => {
    await page.goto("/");
    await waitForAuthenticated(page);

    await page.locator(`.space-switcher button[title="${SEED_SPACE_NAME}"]`).click();

    // The space's sidebar lists its channels as links to /[space]/[room].
    const channelLink = page.locator(`a[href="/${SEED_SPACE_ID}/${SEED_ROOM_ID}"]`);
    await expect(channelLink).toBeVisible();
    await expect(channelLink).toContainText(SEED_ROOM_NAME);
  });

  test("entering the channel renders its messages and composer", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // The seeded message came through the real sendEvents write path and the
    // materialiser, so seeing it proves the whole read projection works.
    await expect(page.getByText("seeded message from the e2e fixture")).toBeVisible();

    // The composer only renders for a caller with write access to the room.
    await expect(composer(page)).toBeVisible();
  });

  test("a deep link to an unknown space does not render a space shell", async ({
    page,
  }) => {
    // `[space]/+layout.ts` rejects a non-DID first segment with a 404 — the
    // guard that stops every stray path from firing a getMetadata query.
    await page.goto("/not-a-space-id");

    // The error boundary's message names the rejected segment, which is the
    // observable proof the guard ran rather than the space layout mounting.
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(
      page.getByText('No space at "not-a-space-id"'),
    ).toBeVisible();
  });
});
