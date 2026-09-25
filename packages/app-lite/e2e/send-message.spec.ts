/**
 * Sending a message — the end-to-end write path.
 *
 * Defends the app's primary interaction: typing in the composer, submitting,
 * and the message becoming real. The final assertion is the load-bearing one —
 * after a reload the message must still be there, which can only be true if it
 * was persisted through `sendEvents` and materialised by the appserver. An
 * optimistic-only placeholder fails it.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { SEED_ROOM_PATH } from "./fixtures.ts";

/** Unique body per test run, so assertions can't match a previous run's row. */
function uniqueMessage(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}`;
}

/** Type `text` into the composer and submit it via the Send button. */
async function sendMessage(page: import("@playwright/test").Page, text: string) {
  const input = composer(page);
  // The composer mounts once the room's metadata query resolves, which is
  // after the authenticated shell renders — so wait on the element itself
  // rather than assuming it is present as soon as the shell is.
  await expect(input).toBeVisible();
  await input.click();
  // `pressSequentially` fires per-key events, which is what a rich-text editor
  // keys off — `fill` would set the DOM without ProseMirror observing it.
  await input.pressSequentially(text);

  const send = page.getByTestId("send-message-button");
  // The Send button only renders once the editor reports content, so its
  // appearance is the editor's acknowledgement of the typed text.
  await expect(send).toBeVisible();
  await send.click();
}

test.describe("sending a message", () => {
  test("the sent message appears in the room", async ({ page }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const text = uniqueMessage("hello from playwright");
    await sendMessage(page, text);

    await expect(page.getByText(text)).toBeVisible();
  });

  test("a sent message survives a reload (it was persisted)", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const text = uniqueMessage("persisted message");
    await sendMessage(page, text);
    await expect(page.getByText(text)).toBeVisible();

    // The placeholder is now gone from the tree entirely; only the appserver
    // can supply this row after a reload.
    await page.reload();
    await waitForAuthenticated(page);

    await expect(page.getByText(text)).toBeVisible();
  });

  test("submitting clears the composer", async ({ page }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const text = uniqueMessage("composer cleared");
    await sendMessage(page, text);
    await expect(page.getByText(text)).toBeVisible();

    // The composer handed the text off — it no longer holds it.
    await expect(composer(page)).toHaveText("");
  });
});
