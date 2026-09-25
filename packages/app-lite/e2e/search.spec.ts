/**
 * Search affordances.
 *
 * Defends: the search feature flag is honoured, the navbar's search entry
 * point renders, and the space-scoped search route answers a query
 * end-to-end.
 *
 * Scope note: channel/thread search (`space.roomy.search.rooms`) is pure
 * SQLite and works hermetically, so it is the assertion. Message search
 * (`space.roomy.search.messages`) is Qdrant-backed and answers 503 when no
 * search service is configured — which is the case in this stack, and is what
 * a self-hosted deployment without Qdrant sees too. The room-search test
 * therefore also covers graceful degradation: the channel results still
 * render even though the message-search query alongside them is failing.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  SEED_ROOM_ID,
  SEED_ROOM_NAME,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
} from "./fixtures.ts";

test.describe("search", () => {
  test("the navbar exposes a search entry point", async ({ page }) => {
    await page.goto("/");
    await waitForAuthenticated(page);

    // At desktop width the navbar renders the searchbar itself (the icon-only
    // trigger is the narrow-container fallback). Both the narrow and wide
    // variants are in the DOM, toggled by container-query CSS, so the
    // assertion is on the one actually visible.
    await expect(page.locator('input[type="search"]:visible')).toBeVisible();
  });

  test("the directory search page renders its results UI", async ({ page }) => {
    await page.goto("/search");
    await waitForAuthenticated(page);

    // With no term the page states what to do — proving the route rendered
    // past the feature-flag gate rather than showing the disabled notice.
    await expect(page.getByText("Type to search all your spaces.")).toBeVisible();
  });

  test("the space search route finds a channel by name", async ({ page }) => {
    await page.goto(`/${SEED_SPACE_ID}/search?q=${SEED_ROOM_NAME}`);
    await waitForAuthenticated(page);

    // A hit proves the whole path: route → query → appserver → rendered row.
    await expect(page.getByText("Channels & threads")).toBeVisible();

    // The result row is the board-view entry; the same href also appears on
    // the sidebar's channel link, so assert on the row that carries the
    // board item's class rather than every link to the room.
    const channelRow = page.locator(
      `a.group[href^="/${SEED_SPACE_ID}/${SEED_ROOM_ID}"]`,
    );
    await expect(channelRow).toHaveCount(1);
    await expect(channelRow).toContainText(SEED_ROOM_NAME);
  });

  test("the space search route shows no channel section for an absent term", async ({
    page,
  }) => {
    const absent = `nothing-matches-${Date.now().toString(36)}`;
    await page.goto(`/${SEED_SPACE_ID}/search?q=${absent}`);
    await waitForAuthenticated(page);

    // The room-results section only renders when there is at least one match,
    // so its absence is the observable "no results" signal.
    await expect(page.getByText("Channels & threads")).toHaveCount(0);
  });

  test("the space search bar is scoped to that space", async ({ page }) => {
    await page.goto(`/${SEED_SPACE_ID}/search?q=${SEED_ROOM_NAME}`);
    await waitForAuthenticated(page);

    // The placeholder carries the space's own name, which proves the route
    // resolved the space rather than rendering a generic bar.
    await expect(
      page.locator(
        `input[type="search"][placeholder="Search ${SEED_SPACE_NAME}"]`,
      ),
    ).toBeVisible();
  });
});
