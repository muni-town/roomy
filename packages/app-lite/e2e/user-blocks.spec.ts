/**
 * Blocking an account — the record round-trip, through the UI.
 *
 * A block is one `space.roomy.user.block` record in the blocker's OWN repo,
 * keyed by a fresh TID. This spec drives the Block action on another account's
 * profile page and then asserts the record's existence and absence in the repo
 * itself, via `listRecords` — the client's own write, against the stub PDS.
 * Only a real `putRecord` produces a listed record, so the assertion cannot
 * pass on a client-side flag.
 *
 * Nothing is hidden yet: blocking is a bookkeeping write in this phase, so the
 * spec deliberately does not assert that the blocked account's messages
 * disappear — they must still render.
 *
 * The `user-blocks` flag is seeded on (see `seed.ts`). The flag-off case
 * rewrites the `getFlags` response for the page, the same way the
 * access-settings spec does, so it needs no admin allowlist.
 */

import type { Page } from "@playwright/test";
import { SCOPE_SETS } from "../src/lib/scopes.ts";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  OTHER_USER_DID,
  OTHER_USER_DISPLAY_NAME,
  PDS_ORIGIN,
  TEST_USER_DID,
} from "./fixtures.ts";

const BLOCK_COLLECTION = "space.roomy.user.block";
const OTHER_USER_PROFILE_PATH = `/user/${OTHER_USER_DID}`;
/** A block rkey is a TID: 13 chars, first char never 0/1, no `l`/`o`/`u`. */
const TID_PATTERN = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

/**
 * The profile page's readiness gate.
 *
 * `waitForAuthenticated` (the shared helper, which waits on the sidebar user
 * card) covers the app finishing its auth round-trip and hydrating; the
 * heading is then the appserver's profile query having landed, which is what
 * "the page is ready for the Block action" means here. Both are needed: on a
 * cold dev-server start the first navigation can paint before the route's
 * modules are transformed, which a bare heading wait would miss.
 */
async function waitForProfile(page: Page): Promise<void> {
  await waitForAuthenticated(page);
  await expect(
    page.getByRole("heading", { name: OTHER_USER_DISPLAY_NAME }),
  ).toBeVisible({ timeout: 30_000 });
}

/** Read `repo`'s block records from the stub PDS, as any client would. */
async function listBlocks(
  page: Page,
  repo: string,
): Promise<{ uri: string; subject: unknown }[]> {
  return await page.evaluate(
    async ({ pdsOrigin, repoDid, collection }) => {
      const res = await fetch(
        `${pdsOrigin}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(repoDid)}&collection=${encodeURIComponent(collection)}`,
      );
      if (!res.ok) throw new Error(`listRecords failed: ${res.status}`);
      const body = (await res.json()) as {
        records: { uri: string; value: { subject?: unknown } }[];
      };
      return body.records.map((r) => ({ uri: r.uri, subject: r.value.subject }));
    },
    { pdsOrigin: PDS_ORIGIN, repoDid: repo, collection: BLOCK_COLLECTION },
  );
}

/**
 * Remove any block of `subject` already in the user's repo.
 *
 * The stub repo lives in the PDS process for the whole run, so a record left
 * behind by an earlier attempt would make the "exactly one" assertion below
 * order-dependent. Clearing first means the block the test writes is the only
 * one that can account for the result.
 */
async function clearBlocksFor(page: Page, subject: string): Promise<void> {
  const existing = await listBlocks(page, TEST_USER_DID);
  const stale = existing.filter((r) => r.subject === subject);
  if (stale.length === 0) return;
  await page.evaluate(
    async ({ pdsOrigin, repoDid, collection, uris }) => {
      for (const uri of uris) {
        const rkey = uri.split("/").pop();
        await fetch(`${pdsOrigin}/xrpc/com.atproto.repo.deleteRecord`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: repoDid, collection, rkey }),
        });
      }
    },
    {
      pdsOrigin: PDS_ORIGIN,
      repoDid: TEST_USER_DID,
      collection: BLOCK_COLLECTION,
      uris: stale.map((r) => r.uri),
    },
  );
}

/** Serve `getFlags` with `user-blocks` removed, before navigation. */
async function withoutUserBlocksFlag(page: Page): Promise<void> {
  await page.route(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.getFlags*`,
    async (route) => {
      // `route.fetch()` bypasses the base fixture's `X-Test-Did` injection, so
      // re-assert it here — the appserver's test-mode verifier reads that
      // header, and without it this 401s.
      const res = await route.fetch({
        headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
      });
      const body = (await res.json()) as { flags?: string[] };
      const flags = (body.flags ?? []).filter((f) => f !== "user-blocks");
      await route.fulfill({ response: res, json: { flags } });
    },
  );
}

/**
 * Set the scope the stub PDS authorizes repo writes against — the session's
 * grant, which a real consent round-trip would have set.
 *
 * Test-mode sessions hold whatever tier they requested, and `blocks` is not in
 * it: the block scope is still ceiling-only, so a write of
 * `space.roomy.user.block` is refused until a spec says otherwise. This test is
 * about the write, not the gate, so it states the grant it assumes. Each test
 * sets its own, so the file is order-independent.
 */
async function setGrantedScope(page: Page, scope: string): Promise<void> {
  const res = await page.request.post(`${PDS_ORIGIN}/__e2e/granted-scope`, {
    data: { scope },
  });
  expect(res.ok()).toBe(true);
}

const blockButton = (page: Page) =>
  page.getByRole("button", { name: "Block this user" });
const unblockButton = (page: Page) =>
  page.getByRole("button", { name: "Unblock this user" });

test.describe("blocking an account", () => {
  test("writes a block record to the user's own repo, then removes it", async ({
    page,
  }) => {
    await page.goto(OTHER_USER_PROFILE_PATH);
    await waitForProfile(page);
    await clearBlocksFor(page, OTHER_USER_DID);

    // The action sits on the other user's profile, and starts unblocked.
    await expect(blockButton(page)).toBeVisible();
    await expect(await listBlocks(page, TEST_USER_DID)).toHaveLength(0);

    // This test covers the write, so the session is given the grant it needs
    // first. Without it the stub PDS refuses the write — the same scope-miss
    // the stale-session test below asserts deliberately.
    await setGrantedScope(page, SCOPE_SETS.blocks);

    await blockButton(page).click();

    // The button flips on the record having been written, so waiting for it
    // also waits for the write.
    await expect(unblockButton(page)).toBeVisible();

    const afterBlock = await listBlocks(page, TEST_USER_DID);
    expect(afterBlock).toHaveLength(1);
    expect(afterBlock[0]?.subject).toBe(OTHER_USER_DID);
    // `key: tid` — one record per block, so the rkey is a TID, not `self`.
    const rkey = afterBlock[0]?.uri.split("/").pop() ?? "";
    expect(rkey).toMatch(TID_PATTERN);

    // The block survives a reload: it is in the repo, not in page state.
    await page.reload();
    await waitForProfile(page);
    await expect(unblockButton(page)).toBeVisible();

    await unblockButton(page).click();
    await expect(blockButton(page)).toBeVisible();
    await expect(await listBlocks(page, TEST_USER_DID)).toHaveLength(0);
  });

  test("flag off: no Block action on another user's profile", async ({
    page,
  }) => {
    await withoutUserBlocksFlag(page);

    await page.goto(OTHER_USER_PROFILE_PATH);
    await waitForProfile(page);

    // The profile itself rendered — the absence below is the flag's doing, not
    // a failed load.
    await expect(
      page.getByRole("heading", { name: OTHER_USER_DISPLAY_NAME }),
    ).toBeVisible();
    await expect(blockButton(page)).toHaveCount(0);
  });

  /**
   * The session predates the block scope.
   *
   * `repo:space.roomy.user.block` arrived with this feature, so a session
   * authorised before it fails the write with a resource-server scope-miss.
   * The response is produced here rather than by the stub repo, which is the
   * only way to reach this branch: the suite's app-password login holds the
   * whole base tier, and a real scope-miss needs a narrower token than any
   * test account has.
   *
   * No consent dialogue is offered. The block scope is not yet registered on
   * the HappyView API client, so a re-authorization carrying it would be
   * refused at session registration and leave the user unable to sign in at
   * all — the dialogue is withheld until the scope becomes requestable
   * (`scopes.ts` UNREGISTERED_SCOPES).
   *
   * Two things are load-bearing and both are asserted: the write is attempted
   * exactly once — a silent retry can never succeed against a token that
   * simply does not carry the scope — and the affordance survives the failure.
   */
  test("a stale session gets a clear message, and the write is not retried", async ({
    page,
  }) => {
    let attempts = 0;
    await page.route(`${PDS_ORIGIN}/xrpc/com.atproto.repo.putRecord`, async (route) => {
      attempts++;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        // The shape the resource server returns for a missing scope.
        body: JSON.stringify({
          error: "ScopeMissingError",
          message:
            'Missing required scope "repo:space.roomy.user.block"',
        }),
      });
    });

    await page.goto(OTHER_USER_PROFILE_PATH);
    await waitForProfile(page);

    await blockButton(page).click();

    // The action fails with the message that says what to do about it, rather
    // than looping on a request that cannot succeed.
    await expect(
      page.getByText(/Sign in again to grant it/),
    ).toBeVisible();
    // The raw scope token is never shown to the user.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(attempts).toBe(1);
    // The affordance is intact: the button is still there, still offering
    // Block rather than a stuck "Blocked".
    await expect(blockButton(page)).toBeVisible();
  });
});
