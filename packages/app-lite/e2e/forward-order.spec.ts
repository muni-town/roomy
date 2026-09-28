/**
 * Forwarding a multi-message SELECTION cross-posts the messages into the
 * destination room in the source room's timeline order.
 *
 * Reported symptom: "multi forwarding messages - original message order gets
 * jumbled". Two things broke the order, both on the client:
 *
 *   1. The selection is kept in TAP order (`toggleMessageSelection`), so
 *      selecting a newer message before an older one forwarded them in that
 *      click order.
 *   2. Every forward was minted inside the same millisecond, and a message's
 *      destination timeline key is its canonical time at millisecond
 *      resolution — so the forwards shared one key and the destination fell
 *      back to an arbitrary tie-break.
 *
 * This spec drives the real UI: select five messages in reverse order, forward
 * them, and read the destination room's rendered order. Pre-fix the forwards
 * land jumbled (the tie-break order); the assertion is that they read
 * oldest → newest, as they do in the source room.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { newUlid } from "@roomy-space/sdk";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_2_ID,
  SEED_ROOM_2_NAME,
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

/**
 * A fresh source channel holding exactly `texts`, seeded through the real
 * write path so the room materialises before the browser reads it.
 *
 * Each message is stamped one millisecond after the previous one. A room's
 * timeline key is a message's canonical time at millisecond resolution, so
 * messages posted in a single batch would share a key and the source order
 * would be arbitrary — there would be no order for the forward to preserve.
 * Real typing is naturally millisecond-separated.
 */
async function seedSourceRoom(texts: string[]): Promise<string> {
  const roomId = newUlid();
  await sendEvents([
    {
      id: roomId,
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name: "forward-source",
    },
  ]);
  const base = Date.now();
  await sendEvents(
    texts.map((text, index) => {
      const event = createMessage(roomId, text);
      return {
        ...event,
        extensions: {
          "space.roomy.extension.timestampOverride.v0": {
            $type: "space.roomy.extension.timestampOverride.v0",
            timestamp: base + index,
          },
        },
      };
    }),
  );
  return roomId;
}

/** The checkbox row for a specific message. */
function messageRow(page: Page, text: string) {
  return page.getByRole("checkbox", { name: "Select message" }).filter({ hasText: text });
}

/** Enter select mode from a message's toolbar (which pre-selects it). */
async function startSelectFrom(page: Page, text: string): Promise<void> {
  await page.getByText(text).first().hover();
  await page.getByLabel("More actions").first().click();
  await page.getByText("Select", { exact: true }).first().click();
  // The select-mode bar replaces the composer, and the message the toolbar was
  // opened from is already selected.
  await expect(page.getByText("1 selected")).toBeVisible();
}

/**
 * The destination room's rendered order, as indices into `expected`. Read from
 * the timeline text: each message's unique body appears once.
 */
async function renderedOrder(page: Page, expected: string[]): Promise<number[]> {
  const timeline = await page.locator("ol").innerText();
  return expected
    .map((text, index) => ({ index, at: timeline.indexOf(text) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.index);
}

test.describe("multi-message forward preserves source order", () => {
  test("a reverse-ordered selection forwards oldest → newest", async ({ page }) => {
    const run = newUlid();
    const texts = Array.from({ length: 5 }, (_, i) => `forward order ${i} ${run}`);
    const sourceRoomId = await seedSourceRoom(texts);

    await page.goto(`/${SEED_SPACE_ID}/${sourceRoomId}`);
    await waitForAuthenticated(page);
    await expect(composer(page)).toBeVisible();
    for (const text of texts) {
      await expect(page.getByText(text)).toBeVisible();
    }

    // Enter select mode from the NEWEST message, then select the rest from
    // newest to oldest — the tap order is the reverse of the timeline order.
    await startSelectFrom(page, texts[4]!);
    for (const text of [texts[3]!, texts[2]!, texts[1]!, texts[0]!]) {
      await messageRow(page, text).click();
    }
    await expect(page.getByText("5 selected")).toBeVisible();

    // Forward to a second seeded channel. `exact` matters: the select bar also
    // renders a preview button whose text is the selected message's body, and
    // role-name matching is a case-insensitive substring.
    await page.getByRole("button", { name: "Forward", exact: true }).click();
    const destination = page
      .getByRole("listitem")
      .filter({ hasText: SEED_ROOM_2_NAME })
      .first();
    await expect(destination).toBeVisible();
    await destination.click();
    await page.getByRole("button", { name: /^Send to 1 room$/ }).click();

    // Wait for the forward to finish before leaving the room. The modal only
    // closes and select mode only ends AFTER `forwardMessages` resolves (see
    // `consumeSelection`), so the composer replacing the select bar is the
    // completion signal. Navigating on the click alone races the `sendEvents`
    // that materialises the destination rows.
    await expect(page.getByText("5 selected")).toHaveCount(0);
    await expect(composer(page)).toBeVisible();

    // The destination room must read in the SOURCE room's order.
    await page.goto(`/${SEED_SPACE_ID}/${SEED_ROOM_2_ID}`);
    await waitForAuthenticated(page);
    await expect.poll(() => renderedOrder(page, texts)).toEqual([0, 1, 2, 3, 4]);
  });
});
