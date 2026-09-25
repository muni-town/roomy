/**
 * Shared Playwright fixtures for app-lite E2E specs.
 *
 * ## Why the header injection exists
 *
 * The appserver runs in `APPSERVER_TEST_MODE`, where `testAuthVerifier` takes
 * the caller's DID from the `X-Test-Did` header instead of verifying a JWT.
 * A browser cannot set that header on requests the app makes, and it must not
 * be enabled outside tests (`testAuthVerifier` accepts any DID with no proof).
 *
 * So the header is injected at the edge, by Playwright, for exactly the
 * requests that go to the local appserver over the page's own origin — which
 * also means the injected header is visible in the trace, rather than hidden
 * behind a patched client. The client still runs its real auth path (login,
 * session, service-auth token); the appserver just answers as the seeded user.
 *
 * Note the appserver is reached at a *different* origin than the page
 * (`:8181` vs `:5181`), so these routes cover both the XRPC HTTP calls and
 * the sync WebSocket handshake.
 */

import { test as base, expect, type Page } from "@playwright/test";
import {
  APPSERVER_HTTP_ORIGIN,
  TEST_USER_DID,
} from "./fixtures.ts";

export { expect };

/**
 * Authenticated page: every request to the local appserver carries
 * `X-Test-Did`, so the appserver resolves the caller as the seeded user.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
      await route.continue({
        headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
      });
    });
    await use(page);
  },
});

/**
 * Wait until the app has finished authenticating.
 *
 * The authenticated shell is proven by the sidebar user card, which the app
 * renders directly (and which is the only place the user's DID is linked).
 * Waiting on it also covers the appserver round-trip that follows login,
 * since the card's text comes from the profile query.
 */
export async function waitForAuthenticated(page: Page): Promise<void> {
  // `.first()`: several elements link to the user (the sidebar card, the
  // profile links inside a message author, a member row), so an unqualified
  // locator is a strict-mode violation, not a visibility check.
  await expect(
    page.locator(`a[href="/user/${TEST_USER_DID}"]`).first(),
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * The message list. `ChatArea` renders an ordered list of timeline rows; the
 * list itself is the stable part of that subtree, since individual rows carry
 * no identifying attribute (see the coverage plan's notes on hooks).
 */
export function messageList(page: Page) {
  return page.locator("ol");
}

/** The Tiptap editable element inside the composer. */
export function composer(page: Page) {
  return page.locator('#chat-input [contenteditable="true"]');
}
