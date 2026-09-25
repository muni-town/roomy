/**
 * Navigation consistency — the shell and the content must agree.
 *
 * A navigation click must move every surface that describes "where am I" to the
 * same place: the navbar's space/room breadcrumb, the sidebar's active channel,
 * the space header, and the chat area's message list. When one of them lags or
 * keeps the previous destination, the shell and the content disagree until a
 * reload — the failure these tests defend against.
 *
 * Each test drives a real navigation and then asserts every surface for the
 * same destination. Playwright's retrying assertions are the settle mechanism:
 * a surface that updates asynchronously passes, and one that never updates —
 * or that updates to a different destination — fails deterministically.
 *
 * The fixtures seed two spaces, with two channels in the first, so both the
 * same-space (channel → channel) and cross-space switch are expressible.
 * `seed.ts` writes rooms and messages through the real `sendEvents` path.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  SEED_MESSAGE_TEXT,
  SEED_ROOM_2_MESSAGE_TEXT,
  SEED_ROOM_2_NAME,
  SEED_ROOM_2_PATH,
  SEED_ROOM_NAME,
  SEED_ROOM_PATH,
  SEED_SPACE_2_MESSAGE_TEXT,
  SEED_SPACE_2_NAME,
  SEED_SPACE_2_ROOM_NAME,
  SEED_SPACE_2_ROOM_PATH,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

/**
 * Assert the whole shell describes one channel — space header, navbar
 * breadcrumb, sidebar highlight and chat content — for `room.name`.
 *
 * Playwright's retrying assertions are the settle mechanism, so this is also
 * the "did everything arrive" check: a surface that updates asynchronously
 * passes here, and one that never updates — or updates to a different
 * destination — fails.
 */
async function expectRoomShell(
  page: Page,
  room: { name: string; message: string },
  spaceName: string,
) {
  await expect(page.locator(".sidebar-header-wrapper")).toContainText(spaceName);
  // The navbar's space-info wrapper holds the space/room breadcrumb. Scoped to
  // the wrapper that carries `overflow-visible`, so the sibling slot that also
  // renders the room name cannot satisfy the assertion instead.
  await expect(
    page.locator(".main-panel .min-w-0.overflow-visible"),
  ).toContainText(room.name);
  // Exactly one row is active, and it names the routed channel — so a stale
  // highlight shows up as either a second match or the wrong name.
  const activeRow = page.locator('.sidebar-body-wrap [data-current="true"]');
  await expect(activeRow).toHaveCount(1);
  await expect(activeRow).toContainText(room.name);
  await expect(page.locator("ol")).toContainText(room.message);
}

test.describe("navigation keeps the shell and the content in sync", () => {
  test("switching channels in one space moves navbar, sidebar and chat together", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expectRoomShell(
      page,
      { name: SEED_ROOM_NAME, message: SEED_MESSAGE_TEXT },
      SEED_SPACE_NAME,
    );

    // Channel → channel inside one space: the space route is reused, so every
    // room-scoped surface must be replaced, not merely left mounted.
    await page.locator(`.sidebar-body-wrap a[href="${SEED_ROOM_2_PATH}"]`).first().click();
    await expectRoomShell(
      page,
      { name: SEED_ROOM_2_NAME, message: SEED_ROOM_2_MESSAGE_TEXT },
      SEED_SPACE_NAME,
    );

    // …and back: nothing may keep the channel it was showing a moment ago.
    await page.locator(`.sidebar-body-wrap a[href="${SEED_ROOM_PATH}"]`).first().click();
    await expectRoomShell(
      page,
      { name: SEED_ROOM_NAME, message: SEED_MESSAGE_TEXT },
      SEED_SPACE_NAME,
    );
  });

  test("switching spaces replaces the sidebar contents and the space header", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expectRoomShell(
      page,
      { name: SEED_ROOM_NAME, message: SEED_MESSAGE_TEXT },
      SEED_SPACE_NAME,
    );

    await page.locator('button[aria-label="Toggle space selector"]').first().click();
    await page
      .locator(`.space-switcher button[title="${SEED_SPACE_2_NAME}"]`)
      .first()
      .click();

    // Cross-space: the sidebar is keyed on the space, so the destination's
    // channels must replace the origin's rather than sit alongside them.
    await expect(page.locator(".sidebar-header-wrapper")).toContainText(
      SEED_SPACE_2_NAME,
    );
    await expect(
      page.locator(`.sidebar-body-wrap a[href="${SEED_SPACE_2_ROOM_PATH}"]`),
    ).toBeVisible();
    // None of the origin space's channels may survive the switch.
    await expect(
      page.locator(`.sidebar-body-wrap a[href="${SEED_ROOM_PATH}"]`),
    ).toHaveCount(0);

    await page
      .locator(`.sidebar-body-wrap a[href="${SEED_SPACE_2_ROOM_PATH}"]`)
      .first()
      .click();
    await expectRoomShell(
      page,
      { name: SEED_SPACE_2_ROOM_NAME, message: SEED_SPACE_2_MESSAGE_TEXT },
      SEED_SPACE_2_NAME,
    );
  });

  test("a space is remembered only once visited, and its sidebar replaces the old one", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expectRoomShell(
      page,
      { name: SEED_ROOM_NAME, message: SEED_MESSAGE_TEXT },
      SEED_SPACE_NAME,
    );

    // Visit the second space, then come back. Having visited its own room is
    // what makes the first space's room "remembered" — the switch must land in
    // that room with every surface describing it, not the second space's.
    await page.locator('button[aria-label="Toggle space selector"]').first().click();
    await page
      .locator(`.space-switcher button[title="${SEED_SPACE_2_NAME}"]`)
      .first()
      .click();
    await page
      .locator(`.sidebar-body-wrap a[href="${SEED_SPACE_2_ROOM_PATH}"]`)
      .first()
      .click();
    await expectRoomShell(
      page,
      { name: SEED_SPACE_2_ROOM_NAME, message: SEED_SPACE_2_MESSAGE_TEXT },
      SEED_SPACE_2_NAME,
    );

    await page.locator('button[aria-label="Toggle space selector"]').first().click();
    await page
      .locator(`.space-switcher button[title="${SEED_SPACE_NAME}"]`)
      .first()
      .click();
    await expectRoomShell(
      page,
      { name: SEED_ROOM_NAME, message: SEED_MESSAGE_TEXT },
      SEED_SPACE_NAME,
    );

    // The second space's channel is gone from the sidebar, not merged into it.
    await expect(
      page.locator(`.sidebar-body-wrap a[href="${SEED_SPACE_2_ROOM_PATH}"]`),
    ).toHaveCount(0);
  });

  test("the space index clears the room surfaces instead of keeping the old room", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_2_PATH);
    await waitForAuthenticated(page);
    await expect(
      page.locator('.sidebar-body-wrap [data-current="true"]'),
    ).toContainText(SEED_ROOM_2_NAME);

    // The index is not a room: the room breadcrumb must drop, and the only
    // highlighted sidebar row becomes the space index — not the channel the
    // user just left.
    await page.locator(`.sidebar-body-wrap a[href="/${SEED_SPACE_ID}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/${SEED_SPACE_ID}$`));
    await expect(
      page.locator(".main-panel .min-w-0.overflow-visible"),
    ).not.toContainText(SEED_ROOM_2_NAME);
    const activeRow = page.locator('.sidebar-body-wrap [data-current="true"]');
    await expect(activeRow).toHaveCount(1);
    await expect(activeRow).toContainText("Index");
  });
});
