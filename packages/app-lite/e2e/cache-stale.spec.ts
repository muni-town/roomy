/**
 * Stale-while-revalidate: an old snapshot still renders, and a failed refetch
 * keeps what is on screen.
 *
 * Two properties of the persistent cache, both end to end:
 *
 *   1. **Age is not a reason to discard.** A snapshot written more than a day
 *      ago still restores, so the room renders its last-known page while the
 *      refetch is in flight. The restore invalidates what it hydrates, which is
 *      what makes the fetch happen at all.
 *
 *   2. **A failed refetch is not an error state.** With the appserver
 *      unreachable, the query keeps the value the snapshot restored and the
 *      app says so once — the banner above the content and the grey dot on the
 *      sidebar user card — instead of replacing the room with an error.
 */
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_MESSAGE_TEXT,
  SEED_ROOM_PATH,
  TEST_USER_DID,
} from "./fixtures.ts";
import { ageSnapshot, readSnapshot } from "./cache-snapshot.ts";
import type { Page } from "@playwright/test";

/** Older than the app's previous 24-hour restore window. */
const SNAPSHOT_AGE_MS = 25 * 60 * 60 * 1000;

/**
 * A route handler that authenticates (the appserver is in test mode) and can
 * hold `room.getMessages` requests open, so what renders is the snapshot rather
 * than a response that would have repaired it first.
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

/** Visit the seeded room and wait for the snapshot to be written to disk. */
async function warmSnapshot(page: Page): Promise<void> {
  await page.goto(SEED_ROOM_PATH);
  await waitForAuthenticated(page, 120_000);
  await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT, {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await readSnapshot(page))?.entries.length ?? 0, {
      timeout: 30_000,
      message: "snapshot written to IndexedDB",
    })
    .toBeGreaterThan(0);
}

test.describe("a stale snapshot is restored, not discarded", () => {
  test("a snapshot more than a day old still renders the room", async ({
    page,
  }) => {
    const gate = installGate(page);
    await gate.install;

    await warmSnapshot(page);
    await ageSnapshot(page, SNAPSHOT_AGE_MS);

    const aged = await readSnapshot(page);
    expect(
      Date.now() - (aged?.savedAt ?? 0),
      "the snapshot is older than a day",
    ).toBeGreaterThan(SNAPSHOT_AGE_MS);

    // Hold the refetch open, so anything on screen came from the snapshot and
    // not from a response that landed first.
    gate.stall(true);
    await page.reload();

    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT, {
      timeout: 30_000,
    });
    // The restore invalidated the key, so the mount did refetch: the held
    // request proves the fetch is in flight behind the restored page.
    await expect
      .poll(() => gate.heldCount(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    gate.releaseAll();
    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT);
  });
});

test.describe("a failed refetch keeps the stale value", () => {
  test("the room stays up, with a banner and a grey dot", async ({ page }) => {
    let offline = false;
    await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
      if (offline) return route.abort("internetdisconnected");
      return route.continue({
        headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
      });
    });

    await warmSnapshot(page);

    // Reload with the appserver unreachable: the restore supplies the room,
    // and every refetch behind it fails.
    offline = true;
    await page.reload();
    await waitForAuthenticated(page, 120_000);

    // The room renders its last-known page rather than an error.
    await expect(page.locator("ol")).toContainText(SEED_MESSAGE_TEXT, {
      timeout: 30_000,
    });
    await expect(page.getByText("Failed to load messages")).toHaveCount(0);

    // And the failure is reported once, non-fatally.
    await expect(
      page.getByText("Showing saved content — the latest couldn't be loaded."),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-status="stale"]')).toBeVisible();
  });
});
