/**
 * The message toolbar stays reachable while reading a tall message.
 *
 * Defends the reported gap: a message body taller than the chat area scrolls
 * its own header — and, with it, the hover toolbar pinned to that header — off
 * the top of the viewport, so a reader deep in the body has no actions until
 * they scroll back up.
 *
 * The toolbar now sticks inside its own message row. That scope is a
 * consequence of the list being virtualized: every message is an absolutely
 * positioned row of a fixed-height container, so a sticky element travels
 * inside its row rather than following the whole timeline. The assertions
 * therefore pin the toolbar to the top of the *chat area* while the pointer is
 * inside that message's row — the behaviour reported as missing.
 *
 * Geometry, not CSS visibility, is the assertion: `toBeVisible` is satisfied by
 * an element scrolled out of the viewport, so a toolbar left absolutely
 * positioned at the message header passes it while being thousands of pixels
 * off-screen. Comparing the toolbar's box against the chat viewport's box is
 * what distinguishes the two, and is why this spec fails on the pre-fix build.
 */

import type { Page } from "@playwright/test";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { newUlid, serializeBlocks } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_2_ID,
  SEED_ROOM_2_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/**
 * Lines in the tall fixture message. At the rendered line height this puts the
 * body several viewport-heights tall, which is the condition under test rather
 * than an incidental size.
 *
 * The message goes to the second channel, not `lobby`: `lobby` is where the
 * specs that post messages add theirs, and its history therefore grows over a
 * run. The virtualizer only keeps a window of rows mounted, so a fixed offset
 * measured in a long channel is a moving target.
 */
const TALL_MESSAGE_LINES = 240;

/** Body text of the tall message, one distinguishable line per row. */
const TALL_MESSAGE_TEXT = Array.from(
  { length: TALL_MESSAGE_LINES },
  (_, i) => `tall body line ${i + 1}`,
).join("\n");

/**
 * How far above the bottom of the content the viewport is parked. Comfortably
 * more than the chat area is tall, so the tall message's header is off-screen
 * and the reader is genuinely inside its body.
 */
const SCROLL_ABOVE_BOTTOM = 900;

/**
 * Ceiling on the toolbar's top edge, as an offset from the chat viewport's top
 * edge, when it is pinned. The anchor sits 24px below the scrollport top and
 * the toolbar is offset a further -16px within it, so a pinned toolbar starts
 * ~8px in; the slack covers the toolbar's own padding and sub-pixel layout.
 * What the bound discriminates is "at the top of the chat area" versus
 * "wherever the message header happens to be", which is far larger.
 */
const PINNED_TOP_MAX = 32;

/** The chat area's scroll container — the element the toolbar pins against.
 *  `bits-ui`'s ScrollArea.Viewport carries this attribute. */
const VIEWPORT_SELECTOR = "[data-scroll-area-viewport]";

/** POST one message through the real write path, as the test user. */
async function sendTallMessage(text: string): Promise<void> {
  const serialized = serializeBlocks([
    { $type: "space.roomy.richtext.blocks#text", text },
  ]);
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
            room: SEED_ROOM_2_ID,
            $type: "space.roomy.message.createMessage.v0",
            body: {
              mimeType: serialized.mimeType,
              data: { $bytes: Buffer.from(serialized.data).toString("base64") },
            },
            extensions: {},
          },
        ],
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(
      `sendTallMessage failed ${resp.status}: ${await resp.text()}`,
    );
  }
}

/**
 * Park the viewport inside the tall message's body, with its header scrolled
 * well out of view, and leave the pointer in the middle of the chat area so the
 * message's hover toolbar is showing.
 *
 * The room's newest message is the tall one, so the chat area opens already
 * scrolled to it — at its *top*, because `scrollToBottom` aligns the last row
 * with `align: "start"`. Scrolling further down from there is what carries the
 * message's header (and, without the sticky anchor, its toolbar) off-screen.
 */
async function scrollIntoBodyAndHover(page: Page): Promise<void> {
  const viewport = page.locator(VIEWPORT_SELECTOR);

  // Wait for the timeline to finish laying out. The message list grows as
  // rows are measured and the virtualizer re-anchors, and a tall row keeps
  // growing after the first paint, so an offset taken mid-layout is measured
  // against a height that is still changing. Poll until the content is both
  // tall enough to scroll in and holding still across consecutive samples —
  // the "tall enough" half also covers the pre-load state, where the empty
  // list is trivially stable.
  let lastHeight = -1;
  await expect
    .poll(
      async () => {
        const { scrollHeight, clientHeight } =
          await viewport.evaluate((el) => ({
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          }));
        const settled =
          scrollHeight === lastHeight &&
          scrollHeight > clientHeight + SCROLL_ABOVE_BOTTOM;
        lastHeight = scrollHeight;
        return settled;
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // The precondition this fixture exists for: a message far taller than the
  // chat area. Asserted rather than assumed, so a body that failed to render
  // tall fails here instead of passing every later assertion vacuously.
  expect(
    await viewport.evaluate(
      (el, above) => el.scrollHeight > el.clientHeight + above,
      SCROLL_ABOVE_BOTTOM,
    ),
  ).toBe(true);

  const target = await viewport.evaluate(
    (el, above) => Math.max(0, el.scrollHeight - el.clientHeight - above),
    SCROLL_ABOVE_BOTTOM,
  );
  await viewport.evaluate((el, top) => {
    el.scrollTop = top;
  }, target);
  // Settle: the virtualizer re-anchors rows after a scroll, which can nudge
  // the offset by a pixel or two.
  await expect
    .poll(async () =>
      Math.abs((await viewport.evaluate((el) => el.scrollTop)) - target),
    )
    .toBeLessThan(8);

  const box = await viewport.boundingBox();
  if (!box) throw new Error("chat viewport has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * The toolbar's top edge relative to the chat viewport's top edge. Negative
 * means it sits above the visible area (scrolled off the top), which is the
 * pre-fix behaviour for a tall message.
 */
async function toolbarTopOffset(page: Page): Promise<number> {
  const box = await page.getByLabel("More actions").first().boundingBox();
  const viewport = await page.locator(VIEWPORT_SELECTOR).boundingBox();
  if (!box || !viewport) throw new Error("toolbar or viewport has no box");
  return box.y - viewport.y;
}

test.describe("the message toolbar while reading a tall message", () => {
  test("stays at the top of the chat area, and stays usable, once scrolled into the body", async ({
    page,
  }) => {
    await sendTallMessage(TALL_MESSAGE_TEXT);

    await page.goto(SEED_ROOM_2_PATH);
    await waitForAuthenticated(page);
    await scrollIntoBodyAndHover(page);

    const actions = page.getByLabel("More actions");
    await expect(actions).toHaveCount(1);

    // The load-bearing assertion: pinned to the top of the chat area rather
    // than carried off-screen by the message header.
    const offset = await toolbarTopOffset(page);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(PINNED_TOP_MAX);

    // Wholly on screen, so the actions are reachable, not merely positioned.
    const viewport = await page.locator(VIEWPORT_SELECTOR).boundingBox();
    const box = await actions.first().boundingBox();
    if (!viewport || !box) throw new Error("toolbar or viewport has no box");
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.y + viewport.height);

    // …and usable: opening the menu is what "reachable without scrolling back"
    // means to a reader.
    await actions.first().click();
    await expect(page.locator('[role="menu"]')).toBeVisible();
  });

  test("keeps tracking the top of the chat area as the reader scrolls on", async ({
    page,
  }) => {
    await sendTallMessage(TALL_MESSAGE_TEXT);

    await page.goto(SEED_ROOM_2_PATH);
    await waitForAuthenticated(page);
    await scrollIntoBodyAndHover(page);

    const actions = page.getByLabel("More actions");
    await expect(actions).toHaveCount(1);

    const viewport = page.locator(VIEWPORT_SELECTOR);
    const near = await toolbarTopOffset(page);

    // A different depth inside the same body. The offset must not drift with
    // the content the toolbar is pinned over — that is the difference between
    // a sticky toolbar and one that merely happens to be on screen.
    const start = await viewport.evaluate((el) => el.scrollTop);
    await viewport.evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - 400);
    });
    await expect
      .poll(async () =>
        start - (await viewport.evaluate((el) => el.scrollTop)),
      )
      .toBeGreaterThan(350);

    // Still inside the body, not at the end of it: this is the same "reading
    // deep in a tall message" condition as before, so the pin is being
    // observed in the situation it exists for.
    expect(
      await viewport.evaluate(
        (el, above) => el.scrollHeight - el.clientHeight - el.scrollTop > above,
        SCROLL_ABOVE_BOTTOM,
      ),
    ).toBe(true);

    expect(await toolbarTopOffset(page)).toBe(near);
  });
});
