/**
 * Persistent cache: a reload renders the room from disk.
 *
 * The near-term promise of the cache-persistence plan is that a returning user
 * sees the room they were in immediately, from a snapshot that survived the
 * reload, instead of the empty shell the first `getMessages` round-trip leaves
 * behind. That is what this spec observes end to end:
 *
 *   1. the room's page is fetched and written to IndexedDB;
 *   2. the page is reloaded with the `getMessages` read path held open;
 *   3. the room still renders its last-known page — served from the snapshot,
 *      not from the response still in flight;
 *   4. the restore invalidated the restored key, so the mount refetched;
 *      releasing the held response reconciles the view.
 *
 * Step 3 is the whole feature; step 4 is the property that stops the restored
 * page from being served forever (a hydrated entry is not stale under
 * `staleTime: Infinity`, so the restore's `invalidateQueries` is load-bearing).
 */
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_MESSAGE_TEXT,
  SEED_ROOM_PATH,
  TEST_USER_DID,
} from "./fixtures.ts";
import { readSnapshot } from "./cache-snapshot.ts";
import type { Page } from "@playwright/test";

/**
 * A route handler that authenticates (the appserver is in test mode) and can
 * hold `room.getMessages` requests open, so what renders is the snapshot
 * rather than a response that would have repaired it first.
 */
function installGate(page: Page) {
  let stall = false;
  const held: Array<{ release: () => void }> = [];

  const install = page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
    const url = route.request().url();
    if (stall && url.includes("room.getMessages")) {
      const { promise, resolve } = Promise.withResolvers<void>();
      held.push({ release: resolve });
      await promise;
    }
    return route.continue({
      headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
    });
  });

  return {
    install,
    stall: (value: boolean) => {
      stall = value;
    },
    heldCount: () => held.length,
    releaseAll: () => {
      for (const entry of held.splice(0)) entry.release();
    },
  };
}

test.describe("a reload renders the room from the persisted cache", () => {
  test("the last page survives the reload, then reconciles on refetch", async ({
    page,
  }) => {
    const gate = installGate(page);
    await gate.install;

    // First visit: the room's page is fetched and (throttled) written to disk.
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page, 120_000);
    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT, {
      timeout: 30_000,
    });

    // The write is throttled off the frame path, so wait for it to land rather
    // than assuming it is synchronous with the render.
    await expect
      .poll(
        async () => (await readSnapshot(page))?.entries.length ?? 0,
        { timeout: 30_000, message: "snapshot written to IndexedDB" },
      )
      .toBeGreaterThan(0);

    // The snapshot holds the timeline, ordered and validated.
    const snapshot = await readSnapshot(page);
    const timeline = snapshot?.entries.find(
      (entry) => entry.key[0] === "space.roomy.room.getMessages",
    );
    expect(timeline, "the timeline is persisted").toBeTruthy();
    const rows = timeline?.state;
    expect(Array.isArray(rows)).toBe(true);
    const messages = rows as Array<{ id: string; sort_idx?: string }>;
    expect(messages.length).toBeGreaterThan(0);
    // Every persisted row carries the server's ordering key.
    expect(messages.every((m) => typeof m.sort_idx === "string")).toBe(true);

    // Freeze the read path, then reload: any content on screen must come from
    // the snapshot, not from the network.
    gate.stall(true);
    await page.reload();

    // The room renders its last-known page while `getMessages` is held open.
    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT, {
      timeout: 30_000,
    });

    // And the restore did refetch — the mount saw the key as invalidated. The
    // held request proves the fetch is in flight, not merely scheduled.
    await expect
      .poll(() => gate.heldCount(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // Releasing it reconciles: the room still shows its message.
    gate.releaseAll();
    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT);
  });
});
