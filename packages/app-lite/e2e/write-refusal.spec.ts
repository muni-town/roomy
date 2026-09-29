/**
 * A send the appserver refuses because the caller can no longer write.
 *
 * The failure this defends: every query holds `staleTime: Infinity` and is
 * refreshed by WebSocket invalidation alone, so `canWrite` is whatever was true
 * when the room's metadata loaded. A caller whose write access is revoked while
 * the app is open keeps an enabled composer, and every send is refused with
 * `403 Caller does not have write access to this room` — reported to the user
 * as an opaque "Message not sent" with the composer still there to send into.
 *
 * The revocation is expressed by changing the identity the appserver
 * authenticates the page as. In `APPSERVER_TEST_MODE` the caller's DID comes
 * from the `X-Test-Did` header the spec fixture injects, so pointing that
 * header at a DID the space has no membership for produces exactly the
 * transition under test — access that was valid when the room loaded and is not
 * valid when the message is sent — through the real XRPC stack and the
 * appserver's own denial path.
 */

import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_PATH,
  TEST_USER_DID,
} from "./fixtures.ts";
import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";

/** The XRPC procedure a refused send fails on. */
const SEND_EVENTS_PATH = "/xrpc/space.roomy.space.sendEvents";

/** A DID with no membership in the seeded space. */
const REVOKED_DID = "did:plc:e2erevoked00000000000000";

/** The notice `ChatInputShell` renders instead of the composer. */
const PERMISSION_NOTICE =
  "You don't have permission to send messages in this channel.";

test.describe("a send refused for lack of write access", () => {
  test("replaces the composer with the permission notice, refusing once", async ({
    page,
  }) => {
    // Identity the page's appserver requests are authenticated as. Flipped to
    // the revoked DID after the room has loaded.
    let callerDid = TEST_USER_DID;
    // Refusing *send* responses the appserver actually issued, so the bound on
    // repeated sends is measured rather than read off the UI. A 403 from the
    // metadata refetch the refusal triggers is not a send, and counting it
    // would inflate the number without saying anything about the composer.
    let refusals = 0;

    // Registered after the fixture's catch-all, so it runs first and its
    // headers win.
    await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), "X-Test-Did": callerDid },
      });
      if (
        response.status() === 403 &&
        new URL(route.request().url()).pathname === SEND_EVENTS_PATH
      ) {
        refusals++;
      }
      await route.fulfill({ response });
    });

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // The composer is live: the "canWrite was true when it loaded" state the
    // WS-only invalidation model leaves behind.
    await expect(composer(page)).toBeVisible();
    await expect(page.getByTestId("send-message-button")).toHaveCount(0);

    // Access is revoked. The page's cached `canWrite` is now wrong, and
    // nothing client-side knows it.
    callerDid = REVOKED_DID;

    const input = composer(page);
    await input.click();
    await input.pressSequentially("this should be refused");
    const send = page.getByTestId("send-message-button");
    await expect(send).toBeVisible();
    await send.click();

    // The composer takes the notice it already shows for `canWrite === false`,
    // without a reload.
    await expect(page.getByText(PERMISSION_NOTICE)).toBeVisible();

    // Handled as the access decision it is, not as a delivery failure.
    await expect(page.getByText(/Message not sent/)).toHaveCount(0);

    // Send and the composer are gone, so the unchanged grant cannot be pressed
    // into a second refusal.
    await expect(page.getByTestId("send-message-button")).toHaveCount(0);
    await expect(input).toHaveCount(0);

    // The bound: one refused send, not one per press.
    expect(refusals).toBe(1);
  });
});
