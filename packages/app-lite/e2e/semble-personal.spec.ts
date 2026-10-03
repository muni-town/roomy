/**
 * E2E: saving a link to the viewer's own Semble collection.
 *
 * The first real exercise of the `semble` scope tier, and the only place the
 * tier's contract can be observed end to end. Three claims, in the order a
 * user meets them:
 *
 *   1. **The action is offered only where it applies.** For a message with
 *      exactly one link, the toolbar's menu carries "Save to my Semble
 *      collection". For a message with none it does not — the affordance is
 *      the link's, not the menu's.
 *   2. **The first attempt is the one the scope gate refuses.** The session's
 *      granted scope is the base tier, which does not cover
 *      `repo:network.cosmik.card?action=create`; the write to the viewer's own
 *      PDS is refused for it, and the refusal is what `guardedXrpc` turns into
 *      the consent dialogue. The dialogue is exercised to its accept button,
 *      and the write is attempted exactly once — never retried — so accepting
 *      cannot loop the action.
 *   3. **With the tier granted, the same action writes the card to the
 *      viewer's own repo.** The card lands in the viewer's repo on the PDS,
 *      asserted by reading it back over the PDS's own `listRecords` — proof of
 *      the write, not of the UI's toast — and it is the Semble URL card for
 *      the link, carrying no message text.
 *
 * What this run cannot exercise, stated plainly: the OAuth consent round-trip
 * itself. App-password (test-mode) sessions have no OAuth token, so
 * `requestScopeExpansion` is a deliberate no-op — there is no PDS authorize
 * endpoint to redirect to and no token to re-issue. Claim 3 is therefore
 * proven by granting the tier the way the round-trip would have, through the
 * PDS stub's control endpoint; the redirect → consent → callback leg itself is
 * covered by the scope-grant/scope-guard unit suites and by the
 * `access-settings` page, not here.
 *
 * The PDS is the run's own stub (`pds-stub.ts`), which enforces the session's
 * granted scope and stores records — the only way to observe both the refusal
 * and a write to the user's own repo without a real PDS. Each test sets the
 * grant it needs, so the file is order-independent.
 */

import type { Page } from "@playwright/test";
import { SCOPE_SETS } from "../src/lib/scopes.ts";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  PDS_ORIGIN,
  SEED_LINK_MESSAGE_URL,
  SEED_MESSAGE_TEXT,
  SEED_ROOM_PATH,
  TEST_USER_DID,
} from "./fixtures.ts";

/** The NSID the action calls, and the collection it writes. */
const CREATE_RECORD_PATH = "/xrpc/com.atproto.repo.createRecord";
const COSMIK_CARD_COLLECTION = "network.cosmik.card";
/** The consent dialogue's title, used to detect it. */
const CONSENT_TITLE = "Save to your Semble collection";
/** Distinctive body of the seeded single-link message. */
const LINK_MESSAGE_TEXT = "worth saving";

/**
 * Open a message's "More actions" menu by its body text.
 *
 * The message row carries no stable test id, so the body is the handle — the
 * same approach the toolbar-menu spec uses.
 */
async function openActionsMenu(page: Page, text: string): Promise<void> {
  await page.getByText(text).first().hover();
  await page.getByLabel("More actions").first().click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
}

/** Read every record the PDS stub stored for the test user's collection. */
async function storedCardRecords(
  page: Page,
): Promise<{ cid: string; value: Record<string, unknown> }[]> {
  const res = await page.request.get(
    `${PDS_ORIGIN}/xrpc/com.atproto.repo.listRecords` +
      `?repo=${encodeURIComponent(TEST_USER_DID)}` +
      `&collection=${encodeURIComponent(COSMIK_CARD_COLLECTION)}`,
  );
  const body = (await res.json()) as {
    records?: { cid: string; value: Record<string, unknown> }[];
  };
  return body.records ?? [];
}

/**
 * Set the scope the stub authorizes repo writes against — the session's grant,
 * which a real consent round-trip would have set. Each test states the grant
 * it assumes rather than inheriting one from a sibling.
 */
async function setGrantedScope(page: Page, scope: string): Promise<void> {
  const res = await page.request.post(`${PDS_ORIGIN}/__e2e/granted-scope`, {
    data: { scope },
  });
  expect(res.ok()).toBe(true);
}

test.describe("saving a link to the viewer's own Semble collection", () => {
  test("the action is offered only for a message carrying one link", async ({
    page,
  }) => {
    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);

    // The seeded link message is offered it …
    await openActionsMenu(page, LINK_MESSAGE_TEXT);
    await expect(
      page.getByRole("menuitem", { name: "Save to my Semble collection" }),
    ).toBeVisible();

    await page.keyboard.press("Escape");

    // … and a message with no link is not: `singleLink` is what gates it, so
    // the absence is the predicate working rather than the menu failing.
    await openActionsMenu(page, SEED_MESSAGE_TEXT);
    await expect(
      page.getByRole("menuitem", { name: "Save to my Semble collection" }),
    ).toHaveCount(0);
  });

  test("the first attempt meets the scope gate exactly once, and never loops", async ({
    page,
  }) => {
    await setGrantedScope(page, SCOPE_SETS.base);

    // Counted at the edge so the bound is measured rather than read off the
    // UI: the write must be attempted once, and accepting the dialogue must
    // not start another.
    let attempts = 0;
    await page.route(`${PDS_ORIGIN}${CREATE_RECORD_PATH}`, async (route) => {
      attempts++;
      await route.continue();
    });

    const before = (await storedCardRecords(page)).length;

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await openActionsMenu(page, LINK_MESSAGE_TEXT);
    await page
      .getByRole("menuitem", { name: "Save to my Semble collection" })
      .click();

    // The scope gate: base does not cover this write, so the PDS refuses it
    // and the refusal surfaces as the dialogue naming the capability, not as
    // an opaque error.
    await expect(page.getByText(CONSENT_TITLE)).toBeVisible();
    // The refusal was the gate's, so nothing was written.
    expect((await storedCardRecords(page)).length).toBe(before);
    expect(attempts).toBe(1);

    await page.getByRole("button", { name: "Grant permission" }).click();
    await expect(page.getByText(CONSENT_TITLE)).toHaveCount(0);

    // Accepting in this mode is a no-op expansion (no OAuth token exists), so
    // the guarded call is not retried: still one attempt, still no card.
    expect(attempts).toBe(1);
    expect((await storedCardRecords(page)).length).toBe(before);

    // The page stays usable after the refusal: the message is still rendered
    // and the action is still offered, rather than the UI being left wedged.
    await openActionsMenu(page, LINK_MESSAGE_TEXT);
    await expect(
      page.getByRole("menuitem", { name: "Save to my Semble collection" }),
    ).toBeVisible();
  });
  test("with the tier granted, the card lands in the viewer's own repo", async ({
    page,
  }) => {
    await setGrantedScope(page, SCOPE_SETS.semble);
    const before = (await storedCardRecords(page)).length;

    await page.goto(SEED_ROOM_PATH);
    await waitForAuthenticated(page);
    await openActionsMenu(page, LINK_MESSAGE_TEXT);
    await page
      .getByRole("menuitem", { name: "Save to my Semble collection" })
      .click();

    // No consent dialogue this time: the grant already covers the write.
    await expect(page.getByText(CONSENT_TITLE)).toHaveCount(0);

    // The card is in the viewer's OWN repo: the request named the caller's DID
    // as `repo`, which is what distinguishes this from the space-card path.
    // Asserted against the record store rather than the toast — a toast's
    // lifetime would make this a race, and says nothing the record does not.
    // Polled because the write is still in flight when the click returns.
    await expect
      .poll(async () => (await storedCardRecords(page)).length, {
        timeout: 15_000,
      })
      .toBe(before + 1);

    const records = await storedCardRecords(page);
    const card = records[records.length - 1]!;
    expect(card.value.$type).toBe(COSMIK_CARD_COLLECTION);
    expect(card.value.type).toBe("URL");
    expect((card.value.content as { url?: string } | undefined)?.url).toBe(
      SEED_LINK_MESSAGE_URL,
    );
    // Only the link is recorded — never the surrounding message text.
    expect(JSON.stringify(card.value)).not.toContain(LINK_MESSAGE_TEXT);
  });
});
