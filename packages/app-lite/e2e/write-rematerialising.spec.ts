/**
 * A send the appserver holds off because the space is being set up.
 *
 * The failure this defends: while a space's per-space database is mid
 * blue-green rebuild, every write to it is answered `409
 * SpaceRematerializing` before the event reaches the log. Nothing applied and
 * the write is safe to resend — but the client rendered it as a hard failure:
 * the row was marked "Not sent" beside the access-refusal rows, and the toast
 * repeated the appserver's own sentence, which names the space DID and an
 * internal step the user can do nothing with.
 *
 * The window is not hypothetical: any deploy that changes the per-space
 * schema puts every busy space through it.
 *
 * The 409 is produced by the spec rather than by the appserver, because the
 * condition is a mid-rebuild state the hermetic stack has no way to enter on
 * demand. The interception is registered after the fixture's catch-all and
 * fulfils the one request it matches, so everything else — auth, queries, the
 * sync socket — still runs through the real stack; only the write's answer is
 * substituted, and it is substituted with exactly the body the appserver's
 * `XrpcError(409, "SpaceRematerializing", …)` produces.
 */

import type { Route } from "@playwright/test";
import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
} from "./fixtures.ts";

/** The XRPC procedure a held-back send fails on. */
const SEND_EVENTS_PATH = "/xrpc/space.roomy.space.sendEvents";

/** The copy the client owns for this state. Kept in step with the module the
 *  app renders it from. */
const FRIENDLY_COPY =
  "Roomy is still setting up this space. Your message will send in a moment.";

/** The appserver's own message for the same failure, verbatim. */
const SERVER_PROSE = `Space ${SEED_SPACE_ID} is being rematerialized; retry the write shortly`;

/** Unique body per run, so assertions can't match an earlier run's row. */
function uniqueMessage(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}`;
}

test.describe("a send held back while the space is set up", () => {
  test("reads as a wait, not as a failed send", async ({ page }) => {
    let held = 0;

    // Registered after the fixture's catch-all, so it runs first. Only the
    // write is answered here; `fallback()` hands every other request back to
    // the fixture, which injects the test identity.
    await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route: Route) => {
      if (
        new URL(route.request().url()).pathname !== SEND_EVENTS_PATH ||
        route.request().method() !== "POST"
      ) {
        await route.fallback();
        return;
      }
      held++;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          error: "SpaceRematerializing",
          message: SERVER_PROSE,
        }),
      });
    });

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    const input = composer(page);
    await expect(input).toBeVisible();
    await input.click();
    const text = uniqueMessage("held back while the space rebuilds");
    await input.pressSequentially(text);
    const send = page.getByTestId("send-message-button");
    await expect(send).toBeVisible();
    await send.click();

    // One write was held back, and the user is told so in the client's words.
    await expect(page.getByText(FRIENDLY_COPY)).toBeVisible();
    expect(held).toBe(1);

    // The appserver's prose is not the user's to read: it names the space DID
    // and an internal step. Neither appears anywhere in the document.
    await expect(page.getByText(/rematerializ/i)).toHaveCount(0);
    await expect(page.getByText(SEED_SPACE_ID)).toHaveCount(0);

    // The row keeps its placeholder and its event, marked as waiting rather
    // than as a permanent failure — Retry resends the same event under the
    // same ULID.
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.getByTestId("queued-delivery")).toBeVisible();
    await expect(page.getByText("Waiting")).toBeVisible();
    await expect(page.getByText("Not sent")).toHaveCount(0);

    const retry = page.getByRole("button", { name: "Retry sending" });
    await expect(retry).toBeVisible();
    await retry.click();

    // Retrying is the same held-back write: the row stays waiting and the copy
    // says the same thing again rather than the raw failure.
    await expect(page.getByTestId("queued-delivery")).toBeVisible();
    await expect(page.getByText(/rematerializ/i)).toHaveCount(0);
    expect(held).toBe(2);
  });
});
