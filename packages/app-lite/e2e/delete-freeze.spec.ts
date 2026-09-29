/**
 * A dialog raised from a message's toolbar must not strand the body scroll
 * lock.
 *
 * Reported symptom: the UI froze after deleting ONE message from the per-message
 * toolbar, while deleting a MULTI-message selection did not. Both write paths
 * emit the same single `deleteMessage` event, so the discriminator is client
 * state: only the toolbar path raises the delete *confirmation* from inside the
 * toolbar's open "More actions" dropdown menu.
 *
 * A dropdown menu is non-modal, but bits-ui's `DropdownMenu.Content` locks the
 * body scroll by default, and `@foxui/core`'s `Modal` (the delete dialog)
 * carries its own bits-ui copy with a *separate* lock map. The dialog's lock
 * therefore snapshots a body that the menu had already made
 * `pointer-events: none; overflow: hidden`, and restores that snapshot when the
 * dialog closes — so the menu/dialog teardown left `<body>` non-interactive and
 * every later click was swallowed. The selection path never opens the menu, so
 * it never overlapped the two locks.
 *
 * This spec defends the observable contract at the browser: after a delete
 * raised from the toolbar's menu (cancelled or confirmed), the page still
 * accepts clicks. `document.body`'s computed `pointer-events` is the tell —
 * bits-ui's lock is the only thing that sets it to `none` at rest.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { newUlid } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/** POST one batch of events through the real write path, as the test user. */
async function sendEvents(events: Record<string, unknown>[]): Promise<void> {
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Did": TEST_USER_DID,
      },
      body: JSON.stringify({ spaceId: SEED_SPACE_ID, events }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
}

/** A createMessage event with a unique ULID and body. */
function createMessage(roomId: string, text: string): Record<string, unknown> {
  const body = Buffer.from(new TextEncoder().encode(text)).toString("base64");
  return {
    id: newUlid(),
    room: roomId,
    $type: "space.roomy.message.createMessage.v0",
    body: { mimeType: "text/plain", data: { $bytes: body } },
    extensions: {},
  };
}

/** Load the room and wait for the timeline + composer to be live. */
async function openRoom(page: Page, text: string): Promise<void> {
  await sendEvents([createMessage(SEED_ROOM_ID, text)]);
  await page.goto(SEED_ROOM_PATH);
  await waitForAuthenticated(page);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText(text)).toBeVisible();
}

/** Hover the message and open its "More actions" menu. */
async function openToolbarMenu(page: Page, text: string): Promise<void> {
  await page.getByText(text).first().hover();
  await page.getByLabel("More actions").first().click();
  await expect(page.getByText("Delete", { exact: true }).first()).toBeVisible();
}

/** The page's interactivity, as observed on the body pointer-events. */
function bodyPointerEvents(page: Page) {
  return page.evaluate(() => getComputedStyle(document.body).pointerEvents);
}

test.describe("toolbar delete does not strand the body scroll lock", () => {
  test("cancelling the confirm dialog leaves the page clickable", async ({
    page,
  }) => {
    const text = `toolbar cancel ${newUlid()}`;
    await openRoom(page, text);

    await openToolbarMenu(page, text);
    await page.getByText("Delete", { exact: true }).first().click();
    const cancel = page.getByRole("button", { name: "Cancel" }).first();
    await expect(cancel).toBeVisible();
    await cancel.click();

    // The dialog and menu are both gone, so the lock must be released.
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect.poll(() => bodyPointerEvents(page)).toBe("auto");

    // The page accepts input again (Playwright's actionability check is the
    // assertion: a stranded `pointer-events: none` makes every click fail).
    await page.getByText(text).first().click();
    await expect(page.getByText(text)).toBeVisible();
  });

  test("confirming the delete leaves the room clickable", async ({ page }) => {
    const target = `toolbar delete ${newUlid()}`;
    const survivor = `toolbar survivor ${newUlid()}`;
    await sendEvents([createMessage(SEED_ROOM_ID, target)]);
    await openRoom(page, survivor);
    await expect(page.getByText(target)).toBeVisible();

    await openToolbarMenu(page, target);
    await page.getByText("Delete", { exact: true }).first().click();
    const confirm = page
      .getByRole("button", { name: /Delete Message/i })
      .first();
    await expect(confirm).toBeVisible();
    await confirm.click();

    // The row leaves the timeline from the appserver's `#messageDiff` remove.
    await expect(page.getByText(target)).toHaveCount(0);
    await expect.poll(() => bodyPointerEvents(page)).toBe("auto");

    // The surviving row is still clickable — the freeze would have swallowed it.
    await page.getByText(survivor).first().click();
    await expect(page.getByText(survivor)).toBeVisible();
  });
});
