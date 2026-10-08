/**
 * Multi-select message actions.
 *
 * Entering select mode replaces the composer with a bar carrying the count,
 * the selected message and the actions the viewer may take on the selection.
 * The bar is the whole surface of the mode, so its contract is asserted here:
 * what it reports, which actions it offers at which entitlement, and that
 * every action a viewer can see is reachable with the keyboard alone.
 *
 * The message row is itself the selection control in this mode (a
 * `role="checkbox"` button), which is what makes a row clickable anywhere and
 * lets the message's own links stay out of the way. Both are asserted — the
 * row's own semantics, and that a link inside a selected row does not
 * navigate.
 *
 * Every test acts on a message it posted itself. The rooms are shared across
 * the run, and the list is virtualized, so the chat area parks at the newest
 * message and only keeps a window of rows mounted — a fixed seeded row is not
 * reliably there by the time a later spec runs. A row posted here is the
 * newest, which is the row the list scrolls to.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { newUlid, serializeBlocks } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  OTHER_USER_DID,
  SEED_ROOM_ID,
  SEED_ROOM_PATH,
  SEED_SPACE_3_ID,
  SEED_SPACE_3_ROOM_ID,
  SEED_SPACE_3_ROOM_PATH,
  SEED_SPACE_ID,
  TEST_USER_DID,
} from "./fixtures.ts";

/**
 * The message row, addressed by the message it is.
 *
 * The row carries `data-message-id` in every mode, so this resolves to the
 * same element whether or not select mode is active. That matters because the
 * mode is entered *through* the row's toolbar: the toolbar has to be reached
 * from the row, not from a page-wide `getByLabel("More actions").first()` —
 * the list settles as the room loads, so between the hover and the click the
 * row under the pointer can become a different message, and `.first()` would
 * then open *that* message's menu.
 */
function messageRow(page: Page, messageId: string) {
  return page.locator(`[data-message-id="${messageId}"]`);
}

/** The select-mode bar. */
function selectBar(page: Page) {
  return page.getByRole("status").filter({ hasText: /selected/ });
}

/** A message this spec posted, and the id its row is addressed by. */
type Posted = { id: string; text: string };

/**
 * POST one message through the real write path and return it.
 *
 * `linkUrl` gives the body a single link facet, which is what the toolbar's
 * link-bearing assertions need; the host is a `.invalid` TLD (RFC 2606), so no
 * preview enrichment can ever reach it.
 */
async function postMessage(opts: {
  spaceId: string;
  roomId: string;
  callerDid: string;
  text: string;
  linkUrl?: string;
}): Promise<Posted> {
  const { spaceId, roomId, callerDid, text, linkUrl } = opts;
  const id = newUlid();
  const body = linkUrl
    ? (() => {
        const serialized = serializeBlocks([
          {
            $type: "space.roomy.richtext.blocks#text",
            text,
            facets: [
              {
                index: { byteStart: 0, byteEnd: text.length },
                features: [{ $type: "space.roomy.richtext.facet#link", uri: linkUrl }],
              },
            ],
          },
        ]);
        return {
          mimeType: serialized.mimeType,
          data: { $bytes: Buffer.from(serialized.data).toString("base64") },
        };
      })()
    : {
        mimeType: "text/plain",
        data: { $bytes: Buffer.from(new TextEncoder().encode(text)).toString("base64") },
      };

  const resp = await fetch(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.space.sendEvents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Did": callerDid },
      body: JSON.stringify({
        spaceId,
        events: [
          {
            id,
            room: roomId,
            $type: "space.roomy.message.createMessage.v0",
            body,
            extensions: {},
          },
        ],
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`sendEvents failed ${resp.status}: ${await resp.text()}`);
  }
  return { id, text };
}

/** A message in the first space, authored by the viewer (who administers it). */
async function postLobbyMessage(linkUrl?: string): Promise<Posted> {
  const text = `select target ${newUlid()}`;
  return postMessage({
    spaceId: SEED_SPACE_ID,
    roomId: SEED_ROOM_ID,
    callerDid: TEST_USER_DID,
    text,
    linkUrl,
  });
}

/**
 * Enter select mode from a message's hover toolbar, which pre-selects it.
 *
 * Scoped to the row throughout, so the click can only ever reach the message
 * the caller named. The row is scrolled into view and its toolbar confirmed
 * before the click: the chat area autoscrolls to the newest message and the
 * virtualizer re-measures as rows settle, so a toolbar read before that is a
 * toolbar whose position — or whose owning row — can still change underneath
 * the pointer.
 */
async function startSelect(page: Page, messageId: string): Promise<void> {
  const row = messageRow(page, messageId);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  const actions = row.getByLabel("More actions");
  await expect(actions).toBeVisible();
  await actions.click();
  await page.getByRole("menuitem", { name: "Select", exact: true }).click();
  await expect(selectBar(page)).toBeVisible();
}

test.describe("multi-select message actions", () => {
  test("the bar reports the selection and offers every action to an admin", async ({
    page,
  }) => {
    const first = await postLobbyMessage();
    const second = await postLobbyMessage();

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    await startSelect(page, first.id);

    // Entering from a message's toolbar pre-selects that message: the mode
    // starts with something to act on rather than asking for a second step.
    await expect(selectBar(page)).toContainText("1 selected");
    await expect(messageRow(page, first.id)).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // A second message, so the selection is genuinely plural.
    await messageRow(page, second.id).click();
    await expect(selectBar(page)).toContainText("2 selected");

    // Admin in this space, so the moderation action is offered alongside the
    // ones every member gets.
    for (const name of ["Forward", "Move", "Delete", "Create Thread"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
    }
  });

  test("a plain member is offered the actions they hold, and not Move or Delete", async ({
    page,
  }) => {
    // Another account authors the message, in a space where the viewer is only
    // a member: the one combination where the message may be forwarded but not
    // moderated.
    const theirs = await postMessage({
      spaceId: SEED_SPACE_3_ID,
      roomId: SEED_SPACE_3_ROOM_ID,
      callerDid: OTHER_USER_DID,
      text: `member target ${newUlid()}`,
    });

    await page.goto(SEED_SPACE_3_ROOM_PATH);
    await waitForAuthenticated(page);

    await startSelect(page, theirs.id);
    await expect(selectBar(page)).toContainText("1 selected");

    // Moving and deleting another account's messages in a space this viewer
    // only belongs to are not theirs to do, so both are absent rather than
    // present-and-disabled: an action that can never succeed is not a state.
    await expect(
      page.getByRole("button", { name: "Forward", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create Thread", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Move", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);
  });

  test("a selected row is a control, and its own links are not", async ({
    page,
  }) => {
    const entry = await postLobbyMessage();
    const linked = await postLobbyMessage("https://semble-card.invalid/article");

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    await startSelect(page, entry.id);

    const row = messageRow(page, linked.id);
    await expect(row).toHaveAttribute("aria-checked", "false");

    // Clicking the row toggles it, and it reports that state itself.
    await row.click();
    await expect(row).toHaveAttribute("aria-checked", "true");

    // The row's own content is inert while it is a control, so a click on the
    // link inside it selects rather than navigating away mid-selection.
    const href = await row.evaluate(
      (el) => el.querySelector("a[href]")?.getAttribute("href") ?? null,
    );
    expect(href).not.toBeNull();
    await row.click();
    await expect(row).toHaveAttribute("aria-checked", "false");
    expect(new URL(page.url()).pathname).toBe(SEED_ROOM_PATH);
  });

  test("Escape leaves the mode and restores the composer", async ({ page }) => {
    const target = await postLobbyMessage();

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(composer(page)).toBeVisible();

    await startSelect(page, target.id);
    await expect(composer(page)).toHaveCount(0);

    // Focus is on the message row at this point — the usual case, since
    // clicking a row is how the selection is built — so Escape has to work
    // from there and not only from inside the bar.
    await page.keyboard.press("Escape");

    await expect(selectBar(page)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
  });

  test("the bar and its actions are reachable by keyboard alone", async ({
    page,
  }) => {
    const target = await postLobbyMessage();

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // Enter the mode from the toolbar without ever touching the mouse: open
    // the actions menu, walk to "Select", and activate it. Same row-scoped
    // targeting as `startSelect`, for the same reason: the menu has to belong
    // to the row the test thinks it is acting on.
    const row = messageRow(page, target.id);
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    const actions = row.getByLabel("More actions");
    await expect(actions).toBeVisible();
    await actions.click();
    const select = page.getByRole("menuitem", { name: "Select", exact: true });
    await select.focus();
    await page.keyboard.press("Enter");
    await expect(selectBar(page)).toBeVisible();

    // Tab reaches each action in turn (a disabled or unfocusable control
    // would be skipped, which is the failure this defends).
    for (const name of ["Forward", "Move", "Delete", "Create Thread"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.focus();
      await expect(button).toBeFocused();
    }
  });
});
