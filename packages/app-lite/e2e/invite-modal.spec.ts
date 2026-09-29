/**
 * The invite modal must not ask a question whose answer cannot exist.
 *
 * The appserver refuses `getInvites` with 403 for a non-admin in a space with
 * member-created invites disabled (`handlers/space.roomy.space.getInvites.ts`),
 * and refuses `createInvite` through `sendEvents` for the same caller. The
 * settings route already gates its query on the predicate the server applies;
 * the modal — the surface a member actually reaches, since the sidebar's
 * Invite button opens it — enabled on `open` alone, so every open issued a
 * request that could never succeed, and the "Create invite link" button left
 * live underneath reported nothing when its press was refused.
 *
 * Both branches are asserted here against the real appserver: the member's
 * open issues no `getInvites` request at all and offers no Create button, and
 * an admin in the same space still reads invites and still creates one.
 *
 * The admin branch re-authenticates the page by swapping `X-Test-Did` on the
 * requests to the local appserver — the same mechanism the fixture uses, and
 * the only difference between the two identities at the server is that header.
 */

import type { Page } from "@playwright/test";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_MEMBER_SPACE_MESSAGE_TEXT,
  SEED_MEMBER_SPACE_ROOM_PATH,
  TEST_ADMIN_DID,
  TEST_NON_MEMBER_DID,
} from "./fixtures.ts";
/** The XRPC query the modal must not issue for a denied caller. */
const GET_INVITES_PATH = "/xrpc/space.roomy.space.getInvites";
/** The XRPC procedure a refused create would fail on. */
const SEND_EVENTS_PATH = "/xrpc/space.roomy.space.sendEvents";

/** The notice the modal and the settings page render for a denied caller. */
const DENIED_NOTICE =
  "You do not have permission to manage invites for this space.";
/** The modal's create affordance. */
const CREATE_BUTTON = "Create invite link";

/**
 * Authenticate the page's appserver requests as `did`, replacing the seeded
 * user the fixture injects. Registered after the fixture's catch-all, so it
 * runs first and its header wins.
 */
async function authenticateAs(page: Page, did: string): Promise<void> {
  await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), "X-Test-Did": did },
    });
  });
}

/** Counts of the two request shapes the modal's permission decides. */
function watchInviteTraffic(page: Page) {
  const requests = { getInvites: 0, sendEvents: 0 };
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path.endsWith(GET_INVITES_PATH)) requests.getInvites += 1;
    if (path.endsWith(SEND_EVENTS_PATH)) requests.sendEvents += 1;
  });
  return requests;
}

/** Open the invite modal from the sidebar's Invite button. */
async function openInviteModal(page: Page) {
  await page.getByLabel("Invite").first().click();
  await expect(
    page.getByRole("heading", { name: "Invite people" }),
  ).toBeVisible();
}

test.describe("the invite modal in a space with member invites disabled", () => {
  test("a member's open issues no getInvites request and offers no Create button", async ({
    page,
  }) => {
    const traffic = watchInviteTraffic(page);

    await page.goto(SEED_MEMBER_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);
    // The room rendered, so the space's metadata (isMember, joinPolicy) has
    // landed — the modal's gate reads exactly that.
    await expect(page.locator("ol")).toContainText(
      SEED_MEMBER_SPACE_MESSAGE_TEXT,
    );

    await openInviteModal(page);

    // The denial is what the member sees: no list (which could only be an
    // error), and no button whose press the server would refuse.
    await expect(page.getByText(DENIED_NOTICE)).toBeVisible();
    await expect(page.getByText("No active invite links.")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: CREATE_BUTTON }),
    ).toHaveCount(0);

    // Let any request reach the network before asserting on the count.
    await page.waitForTimeout(1000);

    // THE REGRESSION: pre-fix the query was enabled on `open` alone, so this
    // is 1 — the 403 the whole gate exists to avoid.
    expect(traffic.getInvites).toBe(0);
    expect(traffic.sendEvents).toBe(0);
  });

  test("an admin's open reads invites and still creates one", async ({
    page,
  }) => {
    await authenticateAs(page, TEST_ADMIN_DID);
    const traffic = watchInviteTraffic(page);

    await page.goto(SEED_MEMBER_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(page.locator("ol")).toContainText(
      SEED_MEMBER_SPACE_MESSAGE_TEXT,
    );

    await openInviteModal(page);

    // The admin branch of the same predicate: invites are read, and the
    // create affordance is offered.
    await expect(page.getByText(DENIED_NOTICE)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: CREATE_BUTTON }),
    ).toBeVisible();
    await expect.poll(() => traffic.getInvites).toBeGreaterThan(0);

    await page.getByRole("button", { name: CREATE_BUTTON }).click();

    // The create reached the appserver and was accepted, and the invite it
    // wrote is on screen — the modal lists it once `createInvite`'s
    // invalidation refetches `getInvites`.
    await expect.poll(() => traffic.sendEvents).toBeGreaterThan(0);
    await expect(page.getByText("No active invite links.")).toHaveCount(0);
    await expect(page.locator("span.font-mono")).toContainText("/join?space=");
  });
});

/**
 * The backstop. The gate is derived from metadata the client cached, so a
 * caller whose access changes under it — or whose metadata loaded from a
 * space that then refused the write — can still reach a live Create button.
 * The press is genuinely refused, and the refusal must be reported rather
 * than swallowed: before the catch, the promise rejected into nothing and the
 * modal stayed on "No active invite links." as if the press had not happened.
 */
test.describe("a refused invite create is reported", () => {
  test("a non-member's press surfaces the server's reason", async ({
    page,
  }) => {
    // Metadata loads as the admin, so the modal renders its allowed branch and
    // offers the button — then the write itself is issued as a DID with no
    // membership, which `sendEvents` refuses. That is the stale-permission
    // shape the catch exists for. One interceptor for both: the read keeps the
    // admin identity, the write takes `writeDid`.
    let writeDid = TEST_ADMIN_DID;
    await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
      const isWrite = new URL(route.request().url()).pathname.endsWith(
        SEND_EVENTS_PATH,
      );
      await route.continue({
        headers: {
          ...route.request().headers(),
          "X-Test-Did": isWrite ? writeDid : TEST_ADMIN_DID,
        },
      });
    });

    await page.goto(SEED_MEMBER_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(page.locator("ol")).toContainText(
      SEED_MEMBER_SPACE_MESSAGE_TEXT,
    );
    await openInviteModal(page);
    await expect(
      page.getByRole("button", { name: CREATE_BUTTON }),
    ).toBeVisible();

    // The caller can no longer write by the time the button is pressed.
    writeDid = TEST_NON_MEMBER_DID;
    await page.getByRole("button", { name: CREATE_BUTTON }).click();

    // The server's own reason is on screen, instead of silence.
    await expect(page.getByText(/is not a member of this space/)).toBeVisible();
  });
});
