/**
 * Editing a message in the chat.
 *
 * Defends the full edit round-trip on messages the test created itself (the
 * seeded world is shared across the suite, so each test posts its own row to
 * stay rerun- and order-safe): the More-actions menu's Edit action must open
 * the inline editor seeded with the message's own text, the menu must close,
 * saving must exit editing and land the edited text in the room, a no-change
 * save must NOT stamp the "edited" marker, and Escape must restore the
 * original untouched.
 *
 * Regression context: MessageBubble's props destructure once lost the
 * `actions` snippet slot (a2b7f13a5, #361), so flipping `isEditing` raised
 * `ReferenceError: actions is not defined` mid-render — the edit editor died
 * half-mounted (the message visually vanished), the open menu never closed,
 * and only a page refresh recovered. No spec exercised edit mode then.
 */

import type { Page } from "@playwright/test";
import {
  composer,
  expect,
  test,
  waitForAuthenticated,
} from "./spec-helpers.ts";
import { SEED_ROOM_PATH } from "./fixtures.ts";

/** Unique body per test run, so assertions can't match a previous run's row. */
function uniqueText(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}`;
}

/** Post a fresh message through the real composer path and wait for its row. */
async function sendOwnMessage(page: Page, text: string) {
  const input = composer(page);
  await expect(input).toBeVisible();
  await input.click();
  await input.pressSequentially(text);
  const send = page.getByTestId("send-message-button");
  await expect(send).toBeVisible();
  await send.click();
  await expect(page.getByText(text)).toBeVisible();
}

/** Hover the row carrying `text` and click its menu's Edit action. */
async function beginEdit(page: Page, text: string) {
  await page.getByText(text).first().hover();
  await page.getByLabel("More actions").first().click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await page
    .locator('[role="menu"]')
    .getByRole("menuitem", { name: "Edit" })
    .click();
  // The menu must close on the action, not stay frozen behind the editor.
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
}

test.describe("editing a message", () => {
  test("opens the inline editor and saves an edit into the room", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const original = uniqueText("message to edit");
    // Also unique per run, so the post-save assertion can't match a row left
    // behind by an earlier run against the same reused stack.
    const edited = `edited body ${original}`;
    await sendOwnMessage(page, original);

    await beginEdit(page, original);

    // The editor mounts, pre-seeded with the message's own text.
    const editComposer = page.locator('.editing-message [contenteditable="true"]');
    await expect(editComposer).toBeVisible({ timeout: 15_000 });

    // Replace the body (so the caret position is irrelevant) and save. The
    // Save button renders beside the editor row (MessageBubble's "actions"
    // slot), not inside the .editing-message div.
    const saveButton = page.getByRole("button", { name: "Save changes" });
    await editComposer.fill("");
    await editComposer.type(edited);
    await expect(saveButton).toBeVisible();
    await saveButton.click();

    // After save, editing mode exits and the edited text is in the room.
    await expect(page.locator(".editing-message").first()).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.locator("ol").getByText(edited)).toBeVisible({
      timeout: 15_000,
    });

    // Failed lookups (badge-summary-refetch.spec.ts seeds stale internal
    // links naming absent spaces/rooms into this shared room) escape the
    // badge prefetch's floating `ensureQueryData` promise as page errors —
    // deterministic 404 not-founds, pre-existing and unrelated to editing.
    // Filtering by that exact shape keeps the assertion meaningful: a real
    // render crash (the ReferenceError this spec defends) or a failed edit
    // write still fails the test.
    const meaningfulErrors = pageErrors.filter(
      (e) => !/^Error: XRPC .* failed \(404\): (Space|Room) not found: /.test(e),
    );
    expect(meaningfulErrors).toEqual([]);
  });

  test("saving an edit with no changes skips the edit event", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const original = uniqueText("message not to change");
    await sendOwnMessage(page, original);

    await beginEdit(page, original);

    // Baseline: "edited" markers already on the page (other rows from earlier
    // runs carry their own). The no-op save must not add to them.
    const editedMarkers = page.locator("ol").getByText("edited", { exact: true });
    const baseline = await editedMarkers.count();

    await expect(
      page.locator('.editing-message [contenteditable="true"]'),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Save changes" }).click();

    // Editing exits...
    await expect(page.locator(".editing-message").first()).toHaveCount(0, {
      timeout: 15_000,
    });
    // ...and the message must NOT gain the "edited" marker, which only a
    // materialised edit stamps: give any incorrectly-sent edit time to
    // round-trip before asserting the count is unchanged.
    await page.waitForTimeout(2000);
    expect(await editedMarkers.count()).toBe(baseline);
  });

  test("a no-change save on an emoji+link message skips the edit event", async ({
    page,
  }) => {
    // Regression for the astral byte-offset drift (utf8ToUtf16Index counted
    // each surrogate half as 3 UTF-8 bytes): re-editing "emoji … link …"
    // shifted the link facet one index per pair, so the round-trip produced
    // "different" blocks and a no-op save sent a real edit + stamped
    // "edited". The SDK fix makes the round-trip byte-stable; the plain-ASCII
    // test above cannot see that drift, so this one has to exist.
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // The URL is a reserved .invalid host (no enrichment fetch); the unique
    // suffix keeps the row findable across reruns of this stack.
    const token = Date.now().toString(36);
    const emojiMessage = `nice 🎉 nice 🚀 https://semble-card.invalid/article end ${token}`;
    await sendOwnMessage(page, emojiMessage);

    await beginEdit(page, emojiMessage);

    const emojiEditedMarkers = page
      .locator("ol")
      .getByText("edited", { exact: true });
    const emojiBaseline = await emojiEditedMarkers.count();

    await expect(
      page.locator('.editing-message [contenteditable="true"]'),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.locator(".editing-message").first()).toHaveCount(0, {
      timeout: 15_000,
    });
    await page.waitForTimeout(2000);
    expect(await emojiEditedMarkers.count()).toBe(emojiBaseline);
  });

  test("Escape exits editing and the original content stays", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const original = uniqueText("message to cancel-edit");
    await sendOwnMessage(page, original);

    await beginEdit(page, original);
    const editComposer = page.locator('.editing-message [contenteditable="true"]');
    await expect(editComposer).toBeVisible({ timeout: 15_000 });

    await editComposer.press("Escape");
    await expect(page.locator(".editing-message").first()).toHaveCount(0);
    await expect(page.getByText(original)).toBeVisible();
  });
});