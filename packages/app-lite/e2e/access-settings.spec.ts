/**
 * The user Access settings page is gated behind the `access-settings` feature
 * flag while progressive scope expansion is iterated on.
 *
 * Defends three things:
 *   - both halves of the gate: flag on → the "Access" sidebar entry is present
 *     and the page renders its real body (from `getScopeSettings`); flag off →
 *     the sidebar entry is gone, and direct navigation to the route still lands
 *     on a gated notice rather than the capability UI.
 *   - the page's central promise: capabilities are shown as plain-language
 *     switches, and no raw OAuth scope token appears on the default view.
 *     Every token in the ceiling is a `kind:value` string, so a `:` is the
 *     signal that one leaked.
 *   - the switch reads the user's saved grant rather than a constant: the spec
 *     serves three different `getScopeSettings` responses and the switches
 *     follow — including a saved UNION of every capability, which must light
 *     both switches rather than trade one for the other.
 *
 * The seed enables the flag globally (see `seed.ts`), so the flag-on case runs
 * against the real projection. The flag-off case rewrites the `getFlags`
 * response for the page — the same value the client predicate consumes — so the
 * test needs no admin allowlist and stays hermetic.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import { APPSERVER_DID, APPSERVER_HTTP_ORIGIN, TEST_USER_DID } from "./fixtures.ts";
import { SCOPE_SETS, capabilityScope } from "../src/lib/scopes.ts";

/**
 * The tier scopes as the *browser* computes them — the comparison the page
 * actually makes.
 *
 * `scopes.ts` embeds `VITE_APPSERVER_DID`, which the stack launcher sets to the
 * hermetic appserver's DID. This spec process never gets that var and so builds
 * each tier against the production default instead. Substituting keeps a served
 * grant equal to the browser's, so a tier actually covers: without it the tier
 * silently misses its appserver-audience token and no switch ever reads on.
 */
const BROWSER_TIERS = {
  semble: SCOPE_SETS.semble.replaceAll("did:web:api.roomy.space", APPSERVER_DID),
  withDms: SCOPE_SETS.withDms.replaceAll("did:web:api.roomy.space", APPSERVER_DID),
  /** `base` ∪ Semble ∪ DMs — the union both capability switches produce. */
  union: capabilityScope(["semble", "withDms"]).replaceAll(
    "did:web:api.roomy.space",
    APPSERVER_DID,
  ),
} as const;

/** Serve `getFlags` with `access-settings` removed, before navigation. */
async function withoutAccessSettingsFlag(page: Page): Promise<void> {
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
      const flags = (body.flags ?? []).filter((f) => f !== "access-settings");
      await route.fulfill({ response: res, json: { flags } });
    },
  );
}

/**
 * Serve `getScopeSettings` with a chosen stored grant, before navigation.
 *
 * The real handler reads the seeded read-state DB, which carries no grant row,
 * so the page would render every switch off and the "follows the saved grant"
 * claim would go untested.
 */
async function withStoredGrant(page: Page, scope: string): Promise<void> {
  await page.route(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.auth.getScopeSettings*`,
    async (route) => {
      const res = await route.fetch({
        headers: { ...route.request().headers(), "X-Test-Did": TEST_USER_DID },
      });
      await route.fulfill({
        response: res,
        json: { scope, requestedScope: null },
      });
    },
  );
}

const SEMBLE_SWITCH = 'button[role="switch"][aria-labelledby="access-semble-name"]';
const DMS_SWITCH = 'button[role="switch"][aria-labelledby="access-withDms-name"]';

test.describe("access-settings flag", () => {
  test("flag on: the Access entry and page render", async ({ page }) => {
    await page.goto("/user/settings");
    await waitForAuthenticated(page);

    const accessLink = page.locator('a[href="/user/settings/scopes"]');
    await expect(accessLink).toBeVisible();

    await accessLink.click();
    await expect(page).toHaveURL(/\/user\/settings\/scopes$/);
    // The page's own heading proves the real body rendered, not the gate.
    await expect(page.getByText("What Roomy can do")).toBeVisible();
    await expect(page.getByText("Access settings are not enabled")).toHaveCount(
      0,
    );
  });

  test("flag off: no Access entry, and direct navigation shows the gate", async ({
    page,
  }) => {
    await withoutAccessSettingsFlag(page);

    await page.goto("/user/settings");
    await waitForAuthenticated(page);

    // The sidebar entry is hidden while the flag is off.
    await expect(page.locator('a[href="/user/settings/scopes"]')).toHaveCount(0);

    // Direct navigation still reaches the route, and it shows the gate
    // rather than the capability rows.
    await page.goto("/user/settings/scopes");
    await expect(page.getByText("Access settings are not enabled")).toBeVisible();
    await expect(page.getByText("What Roomy can do")).toHaveCount(0);
  });

  test("capabilities are plain-language switches, with no scope token in view", async ({
    page,
  }) => {
    await withStoredGrant(page, BROWSER_TIERS.semble);
    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();

    // Each capability is a switch whose accessible name is its own label, so
    // the affordance carries the wording rather than the name in a sibling.
    await expect(page.getByRole("switch")).toHaveCount(2);
    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // The raw scope strings live behind the disclosure, not on the page. A
    // scope token is always `kind:value`, so any `:` in what the page shows is
    // a leak — a real grant is served above, so the string exists to be shown.
    await expect(page.locator("details[open]")).toHaveCount(0);
    await expect(page.locator("code:visible")).toHaveCount(0);
  });

  test("each switch follows the saved grant, not a constant", async ({ page }) => {
    await withStoredGrant(page, BROWSER_TIERS.withDms);
    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();

    // `withDms` carries the DM tier and not the Semble one, so the two
    // switches must disagree — the only shape that distinguishes reading the
    // real grant from hardcoding a state.
    await expect(page.locator(DMS_SWITCH)).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("a saved union grant lights every switch it covers", async ({ page }) => {
    // Enabling one capability must not displace another: the saved grant is the
    // union of everything the user turned on, so a grant carrying both Semble
    // and DMs shows both switches on. A model where each capability replaces
    // the others cannot render this — it would have to pick one.
    await withStoredGrant(page, BROWSER_TIERS.union);
    await page.goto("/user/settings/scopes");
    await waitForAuthenticated(page);
    await expect(page.getByText("What Roomy can do")).toBeVisible();

    await expect(page.locator(SEMBLE_SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator(DMS_SWITCH)).toHaveAttribute("aria-checked", "true");

    // No switch acts on another, so the page carries no copy claiming one does.
    await expect(page.getByText("also stops asking for")).toHaveCount(0);
    await expect(page.getByText("replaces your saved access")).toHaveCount(0);
  });
});
