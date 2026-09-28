/**
 * The message toolbar's popovers survive the pointer leaving the message.
 *
 * Defends the interaction the sticky toolbar could easily break: the toolbar
 * renders on hover and unmounts on `mouseleave`, but both of its popovers — the
 * emoji picker and the "More actions" menu — portal to `body`. Moving the
 * pointer into either one therefore leaves the message row while the popover is
 * still open, and without the toolbar holding itself open the row would unmount
 * and take the popover with it.
 *
 * Moving the toolbar inside its own sticky anchor changes what "leaving the
 * row" means geometrically, which is exactly the kind of change that breaks
 * this by accident — hence the explicit cover.
 *
 * Each test posts its own message and hovers that. The room's history is shared
 * and grows over a run, and the message list is virtualized, so a fixed seeded
 * message is not reliably rendered by the time a later spec runs; the message
 * just posted is the newest, which is the row the chat area scrolls to.
 */

import type { Page } from "@playwright/test";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { newUlid } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/** The chat area's scroll container. */
const VIEWPORT_SELECTOR = "[data-scroll-area-viewport]";

/**
 * The toolbar's emoji popover. It portals to `body` and carries no role or
 * accessible name of its own, so `bits-ui`'s content attribute is the hook —
 * stable, and not dependent on any emoji font being available (the picker
 * renders its grid asynchronously).
 */
const EMOJI_PICKER_SELECTOR = "[data-popover-content]";

/** POST one message through the real write path and return its body text. */
async function postMessage(): Promise<string> {
  const text = `popover target ${newUlid()}`;
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Did": TEST_USER_DID,
      },
      body: JSON.stringify({
        spaceId: SEED_SPACE_ID,
        events: [
          {
            id: newUlid(),
            room: SEED_ROOM_ID,
            $type: "space.roomy.message.createMessage.v0",
            body: {
              mimeType: "text/plain",
              data: { $bytes: Buffer.from(new TextEncoder().encode(text)).toString("base64") },
            },
            extensions: {},
          },
        ],
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`postMessage failed ${resp.status}: ${await resp.text()}`);
  }
  return text;
}

/** Open the room and hover the newest message so its toolbar renders. */
async function openRoomAndHoverNewest(page: Page): Promise<void> {
  const text = await postMessage();
  await page.goto(SEED_ROOM_PATH);
  await waitForAuthenticated(page);

  const message = page.getByText(text).last();
  await expect(message).toBeVisible();
  await message.hover();
  await expect(page.getByLabel("More actions")).toBeVisible();
}

/**
 * Move the pointer well away from the message — into the chat area's
 * bottom-left corner, which is outside the message row but still inside the app
 * — exercising the `mouseleave` that would unmount the toolbar.
 */
async function movePointerOffRow(page: Page): Promise<void> {
  const viewport = await page.locator(VIEWPORT_SELECTOR).boundingBox();
  if (!viewport) throw new Error("chat viewport has no box");
  await page.mouse.move(viewport.x + 8, viewport.y + viewport.height - 8);
}

test.describe("the toolbar's popovers survive the pointer leaving the message", () => {
  test("the actions menu stays open once the pointer leaves the row", async ({
    page,
  }) => {
    await openRoomAndHoverNewest(page);

    await page.getByLabel("More actions").first().click();
    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();

    await movePointerOffRow(page);

    // The popover outlives the hover: unmounting the row would take it with it.
    await expect(menu).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Select" })).toBeVisible();
  });

  test("the emoji picker stays open once the pointer leaves the row", async ({
    page,
  }) => {
    await openRoomAndHoverNewest(page);

    await page.getByLabel("Pick an emoji").first().click();
    const picker = page.locator(EMOJI_PICKER_SELECTOR);
    await expect(picker).toBeVisible();

    await movePointerOffRow(page);

    await expect(picker).toBeVisible();
  });
});
