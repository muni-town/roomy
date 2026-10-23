/**
 * Search depth: message search, its scopes, and the handoff into a room.
 *
 * The stack serves `space.roomy.search.messages` from the launcher's
 * in-process fake Qdrant (see `fake-qdrant.ts`), and the launcher waits for the
 * seeded rows to be indexed before Playwright starts, so a term either has its
 * hit or genuinely has none — the empty result a scoped search asserts is the
 * scope, not a cold index.
 *
 * Each test asserts the seeded message's own body, not merely that a row
 * rendered, so a hit is attributable to the fixture it came from.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  SEED_SEARCH_MESSAGE_ID,
  SEED_SEARCH_MESSAGE_TERM,
  SEED_SEARCH_MESSAGE_TEXT,
  SEED_SEARCH_ROOM_ID,
  SEED_SEARCH_ROOM_NAME,
  SEED_SEARCH_THREAD_ID,
  SEED_SEARCH_THREAD_MESSAGE_TERM,
  SEED_SEARCH_THREAD_MESSAGE_TEXT,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
} from "./fixtures.ts";
import type { Page } from "@playwright/test";

/**
 * One search-result row. The whole row is a single `role="link"` element
 * (the hit's context line, the bubble and any reply preview are inside it);
 * the body text is what makes it the row for a particular message.
 */
function resultRow(page: Page, text: string) {
  return page.locator('main [role="link"]').filter({ hasText: text });
}

test.describe("message search", () => {
  test("a space-scoped search returns the message itself, under its room", async ({
    page,
  }) => {
    await page.goto(`/${SEED_SPACE_ID}/search?q=${SEED_SEARCH_MESSAGE_TERM}`);
    await waitForAuthenticated(page);

    await expect(
      page.getByRole("heading", { name: "Messages" }),
    ).toBeVisible();

    const row = resultRow(page, SEED_SEARCH_MESSAGE_TEXT);
    await expect(row).toHaveCount(1);
    // The hit carries the room it lives in, so the result reads as a message
    // in context rather than as a bare string match.
    await expect(row).toContainText(SEED_SEARCH_ROOM_NAME);
  });

  test("a thread-scoped search does not surface its parent channel's message", async ({
    page,
  }) => {
    // Searching inside a thread must not reach the channel it hangs off —
    // the parent's message is indexed (the space-scoped search above finds
    // it), so its absence here is the scope at work.
    await page.goto(
      `/${SEED_SPACE_ID}/${SEED_SEARCH_THREAD_ID}/search?q=${SEED_SEARCH_MESSAGE_TERM}`,
    );
    await waitForAuthenticated(page);

    await expect(page.getByText("No messages found.")).toBeVisible();
    await expect(resultRow(page, SEED_SEARCH_MESSAGE_TEXT)).toHaveCount(0);

    // And the thread's own message is reachable in that same scope, so the
    // empty result above cannot be a thread that is unsearchable altogether.
    await page.goto(
      `/${SEED_SPACE_ID}/${SEED_SEARCH_THREAD_ID}/search?q=${SEED_SEARCH_THREAD_MESSAGE_TERM}`,
    );
    await expect(resultRow(page, SEED_SEARCH_THREAD_MESSAGE_TEXT)).toHaveCount(
      1,
    );
  });

  test("clicking a result opens the room at that message and highlights it", async ({
    page,
  }) => {
    await page.goto(`/${SEED_SPACE_ID}/search?q=${SEED_SEARCH_MESSAGE_TERM}`);
    await waitForAuthenticated(page);

    await resultRow(page, SEED_SEARCH_MESSAGE_TEXT).click();

    await expect(page).toHaveURL(
      new RegExp(`/${SEED_SEARCH_ROOM_ID}\\?message=${SEED_SEARCH_MESSAGE_ID}`),
    );
    // The row the deep link names is the one the highlight effect marked —
    // the `?message=` param reached the timeline, not just the address bar.
    await expect(
      page.locator(`[data-message-id="${SEED_SEARCH_MESSAGE_ID}"].message-highlight`),
    ).toHaveCount(1);
  });

  test("the scope-expansion link widens the same search to every space", async ({
    page,
  }) => {
    await page.goto(`/${SEED_SPACE_ID}/search?q=${SEED_SEARCH_MESSAGE_TERM}`);
    await waitForAuthenticated(page);

    const expand = page.getByRole("link", { name: "Search in all your spaces" });
    await expect(expand).toBeVisible();
    await expand.click();

    await expect(page).toHaveURL(
      new RegExp(`/search\\?q=${SEED_SEARCH_MESSAGE_TERM}$`),
    );
    const row = resultRow(page, SEED_SEARCH_MESSAGE_TEXT);
    await expect(row).toHaveCount(1);
    // The directory search labels each hit with the space it lives in, which
    // is what tells a widened search apart from the space page's own results.
    await expect(row).toContainText(SEED_SPACE_NAME);
  });
});
