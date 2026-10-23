/**
 * A role write the appserver refuses.
 *
 * Creating, editing and deleting a role all go through `space.sendEvents`,
 * which can fail — the space's account may be rate-limited, the grant may be
 * gone, the appserver may be mid-materialisation. Each form reported that
 * failure only to the console, so the press looked like it did nothing: the
 * modal stayed open with no explanation (inviting another press, which is what
 * "click Save four or five times" actually was) and a refused delete left the
 * role on screen with nothing said.
 *
 * The failure is forced at the wire — the send-events response is replaced
 * with a 500 carrying a message the appserver itself never sends, so the text
 * asserted below can only have come from the refusal. Everything else on the
 * page is the real stack, and each test retries once the refusal is lifted so
 * the same form is shown to still succeed.
 */

import { type Page } from "@playwright/test";
import {
  expect,
  installTestAuth,
  test,
  waitForAuthenticated,
} from "./spec-helpers.ts";
import { APPSERVER_HTTP_ORIGIN, SEED_ADMIN_SPACE_ID } from "./fixtures.ts";

/** The one write path every role mutation batches into. */
const SEND_EVENTS_PATH = "/xrpc/space.roomy.space.sendEvents";

/** A space no other spec creates roles in, whose seeded admin is this user. */
const PERMISSIONS_PATH = `/${SEED_ADMIN_SPACE_ID}/settings/permissions`;

/**
 * Refuse every send-events write for as long as `refusal()` returns a message.
 *
 * Registered after the fixture's catch-all, so it runs first; when it is open
 * it defers to that handler, which is what injects the caller's `X-Test-Did`.
 */
async function refuseWhen(page: Page, refusal: () => string | null) {
  await page.route(`${APPSERVER_HTTP_ORIGIN}${SEND_EVENTS_PATH}`, async (route) => {
    const message = refusal();
    if (message === null) return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "InternalServerError", message }),
    });
  });
}

/** The role list row for a role, which only `getRoles` can have produced. */
function roleRow(page: Page, name: string) {
  return page.getByRole("listitem").filter({ hasText: name });
}

/** Create a role through the real create path and open its detail view. */
async function createRole(page: Page, name: string): Promise<void> {
  await page.goto(PERMISSIONS_PATH);
  await waitForAuthenticated(page);
  await page.getByRole("button", { name: "Create role" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Role name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await roleRow(page, name).getByRole("button").click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

test.describe("a role write the appserver refuses", () => {
  /**
   * Load the app once before the first assertion.
   *
   * The first page load of a run pays the dev server's cold transform of the
   * client, the appserver's first materialisation and the stub PDS's first
   * login at once, which can outlast the shell's own budget. Paying it here
   * keeps the per-test waits about the app rather than about the machine.
   */
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await installTestAuth(page);
    await page.goto(`${PERMISSIONS_PATH}`);
    await waitForAuthenticated(page, 120_000);
    await page.close();
  });

  test("keeps the create modal open with the reason, and creates on retry", async ({
    page,
  }) => {
    const roleName = `E2E Role Create ${Date.now()}`;
    const refusalMessage = "the space is not accepting new roles";
    let refusal: string | null = null;
    await refuseWhen(page, () => refusal);

    await page.goto(PERMISSIONS_PATH);
    await waitForAuthenticated(page);
    await page.getByRole("button", { name: "Create role" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "New Role" })).toBeVisible();

    refusal = refusalMessage;
    await dialog.getByPlaceholder("Role name").fill(roleName);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    await expect(dialog.getByText(refusalMessage)).toBeVisible();
    // Still the user's to retry in: the write did not land, so the form that
    // asked for it is not dismissed.
    await expect(dialog).toBeVisible();

    // The retry clears the notice and does what the first press would have.
    refusal = null;
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(roleRow(page, roleName)).toBeVisible();
    await expect(page.getByText(refusalMessage)).toHaveCount(0);
  });

  test("keeps the edit modal open with the reason, and saves on retry", async ({
    page,
  }) => {
    const roleName = `E2E Role Edit ${Date.now()}`;
    const renamed = `${roleName} renamed`;
    let refusal: string | null = null;
    await refuseWhen(page, () => refusal);

    await createRole(page, roleName);

    await page.getByRole("button", { name: "Role actions" }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit Role" })).toBeVisible();

    refusal = "that role name is reserved";
    await dialog.getByPlaceholder("Role name").fill(renamed);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect(dialog.getByText(refusal)).toBeVisible();
    await expect(dialog).toBeVisible();
    // The refused name is not what the page now claims the role is called.
    await expect(page.getByRole("heading", { name: roleName })).toBeVisible();

    refusal = null;
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    // The stored name, read back: the header is `getRoles` again once the
    // write's invalidation refetches it.
    await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
  });

  test("says the delete failed instead of quietly leaving the role there", async ({
    page,
  }) => {
    const roleName = `E2E Role Delete ${Date.now()}`;
    let refusal: string | null = null;
    await refuseWhen(page, () => refusal);
    // The delete is behind the browser's own confirm.
    page.on("dialog", (confirm) => confirm.accept());

    await createRole(page, roleName);

    refusal = "the role is still assigned to members";
    await page.getByRole("button", { name: "Role actions" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(page.getByText(refusal)).toBeVisible();
    // The role is still the page, because it is still on the server.
    await expect(page.getByRole("heading", { name: roleName })).toBeVisible();

    refusal = null;
    await page.getByRole("button", { name: "Role actions" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // Back to the list, with the role gone from it.
    await expect(page.getByRole("button", { name: "Create role" })).toBeVisible();
    await expect(page.getByText(roleName)).toHaveCount(0);
  });

  test("says a member could not be added to the role", async ({ page }) => {
    const roleName = `E2E Role Member ${Date.now()}`;
    let refusal: string | null = null;
    await refuseWhen(page, () => refusal);

    await createRole(page, roleName);

    // The picker's empty-query state lists the space's members, which is what
    // makes a selection possible without typing a search.
    refusal = "that account cannot hold roles in this space";
    await page.getByPlaceholder("Add member...").click();
    await page
      .locator("ul li button")
      .filter({ hasText: "E2E Tester" })
      .first()
      .click();

    await expect(page.getByText(refusal)).toBeVisible();
    // The role's member list is `getRoles` again: the assignment did not land.
    await expect(page.getByText("No members yet. Add someone below.")).toBeVisible();
  });
});
