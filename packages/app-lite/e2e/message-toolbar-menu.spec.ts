/**
 * The message toolbar's "More actions" menu.
 *
 * Defends the menu's item set and order: the items a viewer is entitled to are
 * the ones that render, in a fixed order, with the destructive Delete last —
 * apart from the rest, where a mis-aimed click cannot reach it. Delete is
 * conditionally rendered (author-or-admin), so the two cases are different
 * menus and both are asserted.
 *
 * The fixtures give the test user admin in the first space and plain member in
 * the third, where someone else authored the visible message: that is the one
 * combination where `canDelete` is false for a message the viewer can still act
 * on, which is what makes the absence assertion meaningful rather than a
 * side-effect of the menu failing to open.
 */

import type { Page } from "@playwright/test";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  SEED_ROOM_PATH,
  SEED_SPACE_3_MESSAGE_TEXT,
  SEED_SPACE_3_ROOM_PATH,
  SEED_MESSAGE_TEXT,
} from "./fixtures.ts";

/**
 * The menu's item labels, in DOM order.
 *
 * The menu portals to `body`, so this is scoped to the open menu itself — the
 * page behind it contains the word "Delete" in the delete-confirmation dialog
 * and "Forward" in the forward modal, neither of which is open here.
 */
async function menuItems(page: Page): Promise<string[]> {
  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  return menu.getByRole("menuitem").allInnerTexts().then((texts) =>
    texts.map((t) => t.trim()),
  );
}

/** Hover a message by its body text and open its "More actions" menu. */
async function openActionsMenu(page: Page, text: string): Promise<void> {
  await page.getByText(text).first().hover();
  await page.getByLabel("More actions").first().click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
}

test.describe("the message toolbar's more-actions menu", () => {
  test("lists Delete last among the other actions", async ({ page }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    await openActionsMenu(page, SEED_MESSAGE_TEXT);

    // The test user authored and administers this message, so every item
    // renders. Delete is the one destructive item and sits at the end.
    expect(await menuItems(page)).toEqual([
      "Edit",
      "Forward",
      "Move",
      "Create Thread",
      "Select",
      "Delete",
    ]);
  });

  test("omits Delete, keeping every other item in order, when it may not delete", async ({
    page,
  }) => {
    await page.goto(SEED_SPACE_3_ROOM_PATH);
    await waitForAuthenticated(page);

    // Another account authored this message and the test user is only a member
    // of the space, so Delete is not offered — while the actions that do not
    // require authorship (or an admin role) still are. Forward is the one
    // unconditional item after Edit, which is author-only.
    await openActionsMenu(page, SEED_SPACE_3_MESSAGE_TEXT);

    const items = await menuItems(page);
    expect(items).not.toContain("Delete");
    expect(items).not.toContain("Edit");
    expect(items).toEqual(["Forward", "Create Thread", "Select"]);
  });
});
