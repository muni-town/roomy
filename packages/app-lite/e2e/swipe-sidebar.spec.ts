/**
 * The open-sidebar swipe stands down while the user is manipulating text.
 *
 * Defends the reported bug: a right-swipe on the main panel opens the mobile
 * sidebar, and the panel's touch handlers sit on an ancestor of the composer —
 * so a long-press drag that extends a text selection inside the composer
 * reaches them, arrives as a large positive `dx` with almost no vertical
 * drift, and opens the sidebar mid-selection.
 *
 * Three gestures are driven with real touch input (CDP `Input.dispatchTouchEvent`,
 * not synthetic events), on a phone viewport:
 *
 * 1. A swipe on the message area opens the sidebar — the gesture itself still
 *    has to work, or the other two assertions pass vacuously.
 * 2. A drag that starts inside the focused composer does not — the guard is
 *    taken from the touch's start target, so this is the reported selection
 *    drag with the selection left out (`document.activeElement` is the field
 *    either way).
 * 3. A drag on the message area while a soft keyboard is up does not.
 *
 * Chromium headless has no soft keyboard, so (3) raises the keyboard by
 * replacing `window.visualViewport` with the shape a phone reports when one is
 * open (layout viewport unchanged, visual viewport shortened). That is a stub,
 * and the spec is explicit about it: it proves the app reads that signal and
 * stands the gesture down on it, not that a real keyboard shortens the
 * viewport. The stub is removed mid-test to show the same drag then opens the
 * sidebar, so the suppression is attributable to the signal and not to the
 * drag failing.
 */

import { devices, type Page } from "@playwright/test";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { SEED_ROOM_PATH } from "./fixtures.ts";

/**
 * The fixed sidebar, whose horizontal position is the observable outcome: it
 * rests one width off-screen and slides to 0 when open. `toBeVisible` cannot
 * tell the two apart — an element translated off-screen still has a box.
 */
const SIDEBAR_SELECTOR = ".sidebar-mobile";
/** `w-64` on the sidebar; the distance it rests off-screen. */
const SIDEBAR_WIDTH = 256;

/** How far a gesture travels horizontally, comfortably past the 50px trigger. */
const SWIPE_DISTANCE = 120;

/** What a phone's soft keyboard covers, in CSS pixels. */
const KEYBOARD_HEIGHT = 340;

/**
 * A touch-enabled phone viewport, which is where the gesture exists. Pixel 5
 * rather than an iPhone descriptor: Playwright's iPhone profiles select
 * WebKit, and this project launches Chromium.
 */
test.use({ ...devices["Pixel 5"] });

function sidebarLeft(page: Page): Promise<number> {
  return page
    .locator(SIDEBAR_SELECTOR)
    .evaluate((el) => el.getBoundingClientRect().x);
}

/** Wait for the sidebar's slide to settle at `expectedX`. */
async function expectSidebarAt(page: Page, expectedX: number): Promise<void> {
  await expect
    .poll(() => sidebarLeft(page), { timeout: 5_000 })
    .toBeCloseTo(expectedX, 0);
}

/**
 * Drag right from `point` as a finger does: one touch, moved in steps (a
 * single jump to the end is a different gesture — no `touchmove` the handler
 * would ever see), then released.
 */
async function dragRight(
  page: Page,
  point: { x: number; y: number },
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const steps = 6;
  const touchAt = (offset: number) => [{ x: point.x + offset, y: point.y }];
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: touchAt(0),
    });
    for (let step = 1; step <= steps; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: touchAt((SWIPE_DISTANCE * step) / steps),
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

/** Centre of the chat area — panel, not composer. */
async function chatAreaCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator("[data-scroll-area-viewport]").boundingBox();
  if (!box) throw new Error("chat viewport has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Centre of the composer's editable region. */
async function composerCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page
    .locator('#chat-input [contenteditable="true"]')
    .boundingBox();
  if (!box) throw new Error("composer has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Replace `window.visualViewport` with the shape a phone reports when a soft
 * keyboard of `keyboardHeight` is open: the layout viewport (`innerHeight`)
 * untouched, the visual viewport shortened by exactly that much.
 */
function stubVisualViewport(keyboardHeight: number): void {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    get: () => ({
      width: window.innerWidth,
      // Read through the getter, so the stub tracks the real viewport rather
      // than a size captured when it was installed.
      height: window.innerHeight - keyboardHeight,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      pageTop: 0,
      pageLeft: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

test.describe("the open-sidebar swipe", () => {
  test("opens the sidebar from the message area", async ({ page }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expectSidebarAt(page, -SIDEBAR_WIDTH);

    await dragRight(page, await chatAreaCentre(page));

    await expectSidebarAt(page, 0);
  });

  test("stands down for a drag that starts in the composer", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const composer = page.locator('#chat-input [contenteditable="true"]');
    await composer.click();
    await page.keyboard.type("text the user is selecting");
    // The precondition the guard reads: the field holds focus, so the drag is
    // text manipulation whichever way it travels.
    await expect(composer).toBeFocused();
    await expectSidebarAt(page, -SIDEBAR_WIDTH);

    await dragRight(page, await composerCentre(page));

    await expectSidebarAt(page, -SIDEBAR_WIDTH);
  });

  test("stands down while a soft keyboard is up", async ({ page }) => {
    await page.addInitScript(stubVisualViewport, KEYBOARD_HEIGHT);

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expectSidebarAt(page, -SIDEBAR_WIDTH);

    const centre = await chatAreaCentre(page);
    await dragRight(page, centre);
    await expectSidebarAt(page, -SIDEBAR_WIDTH);

    // Same drag, same target, keyboard lowered: the sidebar opens, so the
    // suppression above came from the viewport signal rather than from the
    // drag failing to reach the handler at all.
    await page.evaluate(stubVisualViewport, 0);
    await dragRight(page, centre);
    await expectSidebarAt(page, 0);
  });
});
