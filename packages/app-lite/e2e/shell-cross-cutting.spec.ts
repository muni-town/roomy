/**
 * The shell's cross-cutting behaviour — the three things about the frame
 * around the app rather than any one surface inside it.
 *
 * ## The phone layout
 *
 * Below the 640px breakpoint the shell is a different arrangement, not the
 * desktop one squeezed: the sidebar is an overlay drawer that rests off screen
 * and is summoned from the navbar, and the navbar search collapses to its icon.
 * Both tests run on the `mobile-chromium` project only. The rest of the suite
 * asserts the desktop shell — a sidebar that is simply there, a navbar-wide
 * searchbar, hover-revealed toolbars — and at 393px would be asserting the
 * wrong arrangement rather than finding a bug. So that project is narrowed by
 * the group title (`playwright.config.ts`), and each desktop-shaped test here
 * carries a `test.skip(!isMobile)` to keep the desktop project from collecting
 * it in turn.
 *
 * ## A live frame from a second client
 *
 * The room a reader has open is kept current by `#messageDiff` frames, not by
 * polling. The way to show that is with a *second* client: another browser
 * context that authenticates through the same stub PDS and sends through the
 * same `sendEvents` write path. While the reader's own `room.getMessages` is
 * held shut, a refetch cannot be what puts the row on their screen — the frame
 * is the only writer left.
 *
 * ## Deep links
 *
 * The app hands out two shapes of link and both have to land where they say on
 * a cold entry, with no in-app navigation to get there: a room URL (what a
 * share link is) and `?message=<id>` (what a search result, a push
 * notification, and a forwarded message's back-link are).
 *
 * Every wait here is a locator assertion or an `expect.poll` — no
 * `waitForTimeout`.
 */

import type { Browser, Page } from "@playwright/test";
import { newUlid } from "@roomy-space/sdk";
import {
  composer,
  expect,
  installTestAuth,
  test,
  waitForAuthenticated,
} from "./spec-helpers.ts";
import { installGate } from "./held-requests.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/**
 * The fixed sidebar, whose horizontal position is the observable outcome: it
 * rests one width off screen and slides to 0 when summoned. `toBeVisible`
 * cannot tell the two apart — an element translated off screen still has a
 * box.
 */
const SIDEBAR_SELECTOR = ".sidebar-mobile";
/** `w-64` on the sidebar — the distance it rests off screen. */
const SIDEBAR_WIDTH = 256;
/** The chat area's scroll viewport, for "is that row actually on screen". */
const VIEWPORT_SELECTOR = "[data-scroll-area-viewport]";

/** Unique body per run, so an assertion cannot match a previous run's row. */
let seq = 0;
function uniqueText(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}-${seq++}`;
}

/** POST one batch of events through the real write path, as the test user. */
async function sendEvents(
  spaceId: string,
  events: Record<string, unknown>[],
): Promise<void> {
  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Did": TEST_USER_DID,
      },
      body: JSON.stringify({ spaceId, events }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
}

/** Create a channel in the seeded space, through the write path. */
async function createChannel(name: string): Promise<string> {
  const roomId = newUlid();
  await sendEvents(SEED_SPACE_ID, [
    {
      id: roomId,
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name,
    },
  ]);
  return roomId;
}

/**
 * A channel of this test's own, with one message in it.
 *
 * The seeded channels are shared by the whole suite, and the timeline is
 * virtualized and paged at 50 — so by the time a later spec runs, the lobby's
 * oldest row is no longer the row the room opens on, and an assertion naming
 * it fails for a reason that has nothing to do with the behaviour under test.
 * A room this test just created has exactly one message, which is therefore
 * both the newest and the row the room parks on.
 */
async function roomWithMessage(
  prefix: string,
  text: string,
): Promise<{ roomId: string; messageId: string; name: string }> {
  const name = `${prefix}-${newUlid().slice(-6)}`;
  const roomId = await createChannel(name);
  const messageId = await postMessage(roomId, text);
  return { roomId, messageId, name };
}

/** Post one message into an existing channel, returning its id. */
async function postMessage(roomId: string, text: string): Promise<string> {
  const id = newUlid();
  const body = Buffer.from(new TextEncoder().encode(text)).toString("base64");
  await sendEvents(SEED_SPACE_ID, [
    {
      id,
      room: roomId,
      $type: "space.roomy.message.createMessage.v0",
      body: { mimeType: "text/plain", data: { $bytes: body } },
      extensions: {},
    },
  ]);
  return id;
}

/** The row carrying the message with `id`. */
function messageRow(page: Page, id: string) {
  return page.locator(`[data-message-id="${id}"]`);
}

/** The sidebar's horizontal position — the drawer's whole state. */
function sidebarLeft(page: Page): Promise<number> {
  return page
    .locator(SIDEBAR_SELECTOR)
    .evaluate((el) => el.getBoundingClientRect().x);
}

/** Type `text` into the composer and submit it via the Send button. */
async function sendViaComposer(page: Page, text: string): Promise<void> {
  const input = composer(page);
  await expect(input).toBeVisible();
  await input.click();
  // `pressSequentially` fires per-key events, which is what the rich-text
  // editor keys off; `fill` would set the DOM without ProseMirror observing it.
  await input.pressSequentially(text);
  const send = page.getByTestId("send-message-button");
  await expect(send).toBeVisible();
  await send.click();
}

/**
 * A second client: its own browser context, authenticated exactly the way the
 * fixture authenticates the first one — `X-Test-Did` on its appserver traffic,
 * with its login still running the client's real app-password path against the
 * stub PDS. A separate context is the point: separate WebSocket connection,
 * separate query cache, nothing shared with the reader but the appserver.
 *
 * The default desktop window is deliberate — this client only has to reach the
 * composer and press Send, so whatever the reader's own viewport is, the sender
 * does not need to match it.
 */
async function openSecondClient(
  browser: Browser,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const second = await context.newPage();
  await installTestAuth(second);
  return { page: second, close: () => context.close() };
}

test.describe("the shell at a phone breakpoint", () => {
  test("the sidebar is a drawer: off screen, summoned from the navbar, dismissed by tapping away", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "the drawer layout only exists below the 640px breakpoint");

    // The sidebar's own contents are irrelevant here — only the drawer's
    // geometry is asserted — so the room is the seeded channel rather than one
    // this test creates.
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // At rest the drawer is off screen: it is an overlay, not a column. This
    // is the same measurement the swipe spec takes, so a regression here and a
    // regression there describe the same fact.
    await expect.poll(() => sidebarLeft(page), { timeout: 5_000 }).toBeCloseTo(
      -SIDEBAR_WIDTH,
      0,
    );

    // …and it takes no layout space: the main panel starts at the left edge.
    // On desktop the same panel is pushed 256px right by `sm:ml-64`.
    const panel = await page.locator(".main-panel").boundingBox();
    expect(panel, "the main panel has a box").not.toBeNull();
    expect(panel!.x).toBe(0);

    // The navbar offers the way in. The toggle is `sm:hidden`, so its being
    // visible here is the desktop/mobile split itself, not decoration.
    const toggle = page.getByRole("button", {
      name: "Navigation",
      exact: true,
    });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    await expect.poll(() => sidebarLeft(page), { timeout: 5_000 }).toBe(0);
    // The control reports the state it produced, which is what makes it a
    // toggle rather than a one-way opener.
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Tapping the backdrop dismisses it. The backdrop is `fixed inset-0` and
    // sits under the drawer (`z-30` against `z-40`), so the tap has to land
    // clear of the drawer's 256px.
    const size = page.viewportSize();
    expect(size, "the page has a viewport").not.toBeNull();
    await page.mouse.click(size!.width - 20, size!.height / 2);
    await expect
      .poll(() => sidebarLeft(page), { timeout: 5_000 })
      .toBeCloseTo(-SIDEBAR_WIDTH, 0);
  });

  test("the navbar search is an icon that expands into the bar", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "the collapsed searchbar only exists on a narrow navbar");

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // At rest there is no search field — the navbar is the icon. (`:visible`
    // because the wide-container bar is in the DOM behind a container query;
    // only the one actually laid out counts.)
    await expect(page.locator('input[type="search"]:visible')).toHaveCount(0);

    const icon = page.getByRole("button", { name: "Search", exact: true });
    await expect(icon).toBeVisible();

    await icon.click();

    // The icon is an entry point, not a decoration: it expands into the
    // searchbar, and the term submitted there reaches the scoped search route.
    const field = page.locator('input[type="search"]:visible');
    await expect(field).toBeVisible();
    await field.fill("lobby");
    await field.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/${SEED_SPACE_ID}/${SEED_ROOM_ID}/search\\?q=lobby$`),
    );
  });
});

test.describe("a frame from a second client reaches the open room", () => {
  test("a message sent from another client appears without a reload", async ({
    page,
    browser,
  }) => {
    // Two browser boots and the write they pass between them, on a stack whose
    // reader is deliberately holding the appserver's read path open. The
    // second client's first navigation pays the same cold cost a first
    // navigation always does here (Vite compiling the routes, the PDS login),
    // measured at 28–32s in `room-kinds.spec.ts`, and it does so while the
    // first client is still working — so this test gets the headroom that one
    // documents rather than the default budget.
    test.slow();

    // A room of this test's own: the reader must be parked on a row that
    // exists when the test opens it, and the shared channels grow past one
    // virtualized page as the suite runs.
    const openerText = uniqueText("the room the reader has open");
    const room = await roomWithMessage("live-frame", openerText);
    const path = `/${SEED_SPACE_ID}/${room.roomId}`;

    // Hold this reader's own room reads shut for the length of the test. The
    // gate is installed before the first navigation so it also owns the
    // request the initial load makes — it continues them with the same
    // test-auth header the fixture's own route would have added.
    const gate = installGate(page);
    await gate.install;

    await page.goto(path);
    await waitForAuthenticated(page);
    await expect(page.locator("ol")).toContainText(openerText);

    // From here on, a `room.getMessages` refetch is parked. That is what makes
    // the assertion below mean "the frame did it": with the read path frozen,
    // a row can only reach the screen through the live diff.
    gate.stall(true);

    // A marker on the document and the URL are how "without a reload" is read:
    // a reload would wipe the first and a navigation would change the second.
    await page.evaluate(() => {
      document.documentElement.dataset.readerMarker = "still here";
    });
    const readerUrl = page.url();

    const sender = await openSecondClient(browser);
    const text = uniqueText("live from the second client");
    await sender.page.goto(path);
    await waitForAuthenticated(sender.page, 60_000);
    await sendViaComposer(sender.page, text);

    // The second client stays open until the row is on the reader's screen.
    // The composer's send is fire-and-forget, so tearing the context down on
    // the click alone races the `sendEvents` that would materialise the row —
    // and the assertion below can only pass if that write landed.
    await expect(page.getByText(text)).toBeVisible();

    expect(page.url()).toBe(readerUrl);
    expect(
      await page.evaluate(() => document.documentElement.dataset.readerMarker),
    ).toBe("still here");

    gate.releaseAll();
    await sender.close();
  });
});

test.describe("deep links", () => {
  test("a cold room link lands in that room, with the shell agreeing", async ({
    page,
  }) => {
    const targetText = uniqueText("the room a share link names");
    const room = await roomWithMessage("share-link", targetText);
    const path = `/${SEED_SPACE_ID}/${room.roomId}`;

    // Nothing before this navigates: the room is reached from a bare URL, the
    // way a share link is.
    await page.goto(path);
    await waitForAuthenticated(page);

    // The room's own content — the message came through the real write path
    // and the materialiser, so reading it back is the route having resolved to
    // this room rather than to an empty shell.
    await expect(page.locator("ol")).toContainText(targetText);
    await expect(composer(page)).toBeVisible();

    // And the shell describes the same room: exactly one sidebar row is
    // active, and it is this channel rather than the one the reader was in
    // before (there is no before — the URL is the only input). Asserted as
    // text, not visibility, because the row is correctly off screen at a phone
    // viewport and this test also runs there.
    const activeRow = page.locator('.sidebar-body-wrap [data-current="true"]');
    await expect(activeRow).toHaveCount(1);
    await expect(activeRow).toContainText(room.name);
    expect(page.url()).toContain(path);
  });

  test("a ?message= link lands on that message and marks it", async ({ page }) => {
    // A room of this test's own: the target has to be old enough that opening
    // the room at the newest end leaves it off screen, and the shared channels
    // grow past one page as the suite runs.
    const targetText = uniqueText("the message the link names");
    const room = await roomWithMessage("deep-link", targetText);
    // A second batch, so these are strictly later than the target and it is the
    // oldest row in the room rather than one of a same-millisecond burst.
    for (let i = 0; i < 30; i++) {
      await postMessage(room.roomId, `filler ${i} ${uniqueText("")}`);
    }

    await page.goto(`/${SEED_SPACE_ID}/${room.roomId}?message=${room.messageId}`);
    await waitForAuthenticated(page);

    // The row carries the mark only while the deep link names it, and it can
    // only be rendered at all once the effect has scrolled the virtualizer to
    // it — a room opened normally parks at the newest row and leaves this one
    // unmounted.
    const row = messageRow(page, room.messageId);
    await expect(row).toHaveClass(/message-highlight/, { timeout: 15_000 });
    await expect(row).toContainText(targetText);

    // Rendering is not landing: the row has to be inside the chat area's
    // viewport, which is the whole point of a link that names a message. The
    // scroll happens after the row mounts, so this is polled to its settled
    // geometry rather than read once.
    await expect
      .poll(async () => {
        const viewport = await page.locator(VIEWPORT_SELECTOR).boundingBox();
        const box = await row.boundingBox();
        if (!viewport || !box) return false;
        return (
          box.y < viewport.y + viewport.height &&
          box.y + box.height > viewport.y
        );
      }, { timeout: 15_000 })
      .toBe(true);
  });
});
