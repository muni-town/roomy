/**
 * The Integrations settings page: three collapsible sections, each with its own
 * boundary.
 *
 * What this defends:
 *
 * * The page is a set of **separate** sections, not one long form. Each header
 *   is a real button that reports `aria-expanded`, and its panel is a labelled
 *   region — so a screen reader announces which integration is being changed,
 *   and a section's selectors cannot match another's content.
 * * **Discord is reachable only through Integrations.** The old
 *   `settings/discord-bridge` URL redirects, because a bookmark or an old link
 *   must not land on a page that no longer exists.
 * * The **Pro badge is on Discord only.** The gate prices the Discord bridge;
 *   Bluesky and Matrix are not Pro features, so marking them would misprice them.
 * * The Matrix section states the encryption trade-off **before** the connect
 *   form: the bridge reads every message it relays, and history from before it
 *   joined an encrypted room stays unreadable.
 * * "Also bridge rooms created later" is **unchecked by default.** An admin must
 *   choose to have rooms they have not seen bridged automatically; defaulting it
 *   on would bridge them silently.
 *
 * The bridge's admin API is fulfilled here. The section's own logic — validation,
 * default states, which fields appear for which kind — is what is under test,
 * not the bridge's answers.
 */

import type { Page, Route } from "@playwright/test";
import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { MATRIX_BRIDGE_ORIGIN, SEED_SPACE_ID } from "./fixtures.ts";

/**
 * Answer the admin API the way the bridge does.
 *
 * `/capabilities` and `/health` are unauthenticated; everything else is gated,
 * but the section only reaches a gated endpoint once the caller has a token, so
 * a permissive stub keeps the test on the section's behaviour.
 */
async function stubAdminApi(page: Page) {
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });

    if (path.endsWith("/health")) {
      return json({ ok: true, portalCount: 0, e2ee: true, homeserver: "synapse" });
    }
    if (path.endsWith("/capabilities")) {
      return json({
        msc4190Devices: true,
        msc2409Ephemeral: true,
        msc4203ToDevice: true,
        msc3202DeviceLists: true,
        msc3202OtkCounts: true,
        msc3202FallbackKeys: true,
        e2eeAvailable: true,
        details: [],
      });
    }
    if (path.endsWith("/bridges") && route.request().method() === "GET") {
      return json({ bridges: [] });
    }
    return json({ error: "not stubbed" }, 404);
  };

  await page.route(`${MATRIX_BRIDGE_ORIGIN}/**`, handler);
}

/**
 * Open the Integrations page as an authenticated admin.
 *
 * `waitForAuthenticated` proves the shell rendered, which is what the page needs
 * before it can read `page.params.space`.
 */
async function openIntegrations(page: Page) {
  await page.goto(`/${SEED_SPACE_ID}/settings/integrations`);
  await waitForAuthenticated(page, 60_000);
}

async function openMatrixSection(page: Page) {
  await openIntegrations(page);
  const header = page.getByRole("button", { name: /^Matrix/ });
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  return page.getByRole("region", { name: /^Matrix/ });
}

test.describe("integrations settings", () => {
  test("renders one collapsible section per integration", async ({ page }) => {
    await openIntegrations(page);

    for (const name of ["Bluesky", "Discord", "Matrix"]) {
      const header = page.getByRole("button", { name: new RegExp(`^${name}`) });
      await expect(header).toBeVisible();
      // A button that opens a panel must report whether it is open.
      await expect(header).toHaveAttribute("aria-expanded", /true|false/);
    }
  });

  test("expanding a section reveals a labelled region", async ({ page }) => {
    await openIntegrations(page);

    const matrix = page.getByRole("button", { name: /^Matrix/ });
    await expect(matrix).toHaveAttribute("aria-expanded", "false");
    await matrix.click();
    await expect(matrix).toHaveAttribute("aria-expanded", "true");

    // The panel is a region named after its section, which is what keeps a
    // section's selectors from matching another section's content.
    await expect(page.getByRole("region", { name: /^Matrix/ })).toBeVisible();
  });

  test("the Discord page redirects to Integrations", async ({ page }) => {
    await page.goto(`/${SEED_SPACE_ID}/settings/discord-bridge`);
    await waitForAuthenticated(page, 60_000);
    await expect(page).toHaveURL(
      new RegExp(`/${SEED_SPACE_ID}/settings/integrations`),
    );
  });

  test("the Pro badge marks Discord and nothing else", async ({ page }) => {
    await openIntegrations(page);

    const discord = page.getByRole("button", { name: /^Discord/ });
    const blue = page.getByRole("button", { name: /^Bluesky/ });
    const matrix = page.getByRole("button", { name: /^Matrix/ });

    // The badge is part of the header, so its presence is what distinguishes the
    // gated section from the ungated ones.
    await expect(discord).toContainText(/Pro|free up to/);
    await expect(blue).not.toContainText(/\bPro\b/);
    await expect(matrix).not.toContainText(/\bPro\b/);
  });

  test("the Matrix section states the encryption trade-off", async ({ page }) => {
    await stubAdminApi(page);
    const panel = await openMatrixSection(page);

    // Both halves of the trade-off: the bridge reads what it relays, and history
    // from before it joined an encrypted room is unreadable.
    await expect(panel).toContainText(/reads every message|relaying is copying/i);
    await expect(panel).toContainText(/encrypted/i);
    await expect(panel).toContainText(/before the bridge joined|unreadable/i);
  });

  test("the auto-bridge checkbox is unchecked by default", async ({ page }) => {
    await stubAdminApi(page);
    const panel = await openMatrixSection(page);

    // Only a space bridge offers the choice, so the checkbox appears once Space
    // is selected — and it must be off when it does. The toggle group renders its
    // inputs `sr-only` inside a label, so the label's text is the click target.
    await panel.getByText("Space", { exact: true }).click();
    const autoBridge = panel.getByRole("checkbox", {
      name: /also bridge rooms created later/i,
    });
    await expect(autoBridge).toBeVisible();
    await expect(autoBridge).not.toBeChecked();
  });
});
