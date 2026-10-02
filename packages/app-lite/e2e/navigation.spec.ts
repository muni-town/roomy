/**
 * Space list and room navigation.
 *
 * Defends: the seeded space and its channel are materialised and visible, and
 * navigating into them renders that room's data. If `getSpaces`, the sidebar
 * assembly (`getMetadata`), or the room route's read path breaks, these fail.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  SEED_ROOM_ID,
  SEED_ROOM_NAME,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  SEED_SPACE_NAME,
} from "./fixtures.ts";

test.describe("space list and room navigation", () => {
  test("lists the joined space in the sidebar", async ({ page }) => {
    await page.goto("/");
    await waitForAuthenticated(page);

    // The space switcher renders one button per joined space, titled by name.
    const spaceButton = page.locator(
      `.space-switcher button[title="${SEED_SPACE_NAME}"]`,
    );
    await expect(spaceButton).toBeVisible();
  });

  test("navigating into the space shows its channel", async ({ page }) => {
    await page.goto("/");
    await waitForAuthenticated(page);

    await page.locator(`.space-switcher button[title="${SEED_SPACE_NAME}"]`).click();

    // The space's sidebar lists its channels as links to /[space]/[room].
    const channelLink = page.locator(`a[href="/${SEED_SPACE_ID}/${SEED_ROOM_ID}"]`);
    await expect(channelLink).toBeVisible();
    await expect(channelLink).toContainText(SEED_ROOM_NAME);
  });

  test("entering the channel renders its messages and composer", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // The seeded message came through the real sendEvents write path and the
    // materialiser, so seeing it proves the whole read projection works.
    await expect(page.getByText("seeded message from the e2e fixture")).toBeVisible();

    // The composer only renders for a caller with write access to the room.
    await expect(composer(page)).toBeVisible();
  });

  test("a deep link to an unknown space does not render a space shell", async ({
    page,
  }) => {
    // `[space]/+layout.ts` rejects a non-DID first segment with a 404 — the
    // guard that stops every stray path from firing a getMetadata query.
    await page.goto("/not-a-space-id");

    // The error boundary's message names the rejected segment, which is the
    // observable proof the guard ran rather than the space layout mounting.
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(
      page.getByText('No space at "not-a-space-id"'),
    ).toBeVisible();
  });

  test("a deep link to a room slug issues no id-expecting XRPC call", async ({
    page,
  }) => {
    // `[room]/+layout.ts` rejects a second segment that is not a ULID. Without
    // it the room subtree mounts and passes the segment straight into
    // `getMessages` / `getMetadata` / `updateSeen`, each of which takes a room
    // id — the requests that answered `404 Room not found: radial` in
    // production (75 in one 36-minute window). Counting at the network is the
    // point: the DOM alone cannot show that no request was issued.
    //
    // Scoped to the room-scoped NSIDs the route owns; the shell's own
    // auth/profile/space-list traffic is unaffected by this route and would
    // otherwise make the assertion a statement about the whole app.
    const roomXrpc: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/xrpc/space.roomy.room.")) roomXrpc.push(req.url());
    });

    await page.goto(`/${SEED_SPACE_ID}/radial`);

    // 30s, matching `waitForAuthenticated`: the first navigation in a run pays
    // Vite's cold dev transform of the whole route graph, which is well past
    // the 15s default.
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('No room at "radial"')).toBeVisible();

    expect(roomXrpc).toEqual([]);
  });
});
