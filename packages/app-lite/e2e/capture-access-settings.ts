/**
 * Capture the Access settings page.
 *
 * Not a spec: this script drives the same hermetic stack the E2E suite uses
 * (see `launch-stack.ts`) and writes PNGs of the page, so a design change to
 * it can be reviewed and diffed as images. It asserts nothing.
 *
 *   bun run e2e/launch-stack.ts            # in one shell
 *   bun run e2e/capture-access-settings.ts # in another
 *
 * Output: `e2e/screenshots/access-<label>-<n>-<name>.png`.
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { APP_LITE_ORIGIN } from "./fixtures.ts";
import { installTestAuth, waitForAuthenticated } from "./spec-helpers.ts";

const label = process.argv[2] ?? "before";
const OUT_DIR = join(import.meta.dirname, "screenshots");
mkdirSync(OUT_DIR, { recursive: true });

let step = 0;
async function shot(page: Page, name: string): Promise<void> {
  step += 1;
  const file = join(
    OUT_DIR,
    `access-${label}-${String(step).padStart(2, "0")}-${name}.png`,
  );
  await page.screenshot({ path: file, fullPage: true });
  console.log(`wrote ${file}`);
}

async function openPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await installTestAuth(page);
  await page.goto(`${APP_LITE_ORIGIN}/user/settings/scopes`);
  await waitForAuthenticated(page);
  await page.waitForTimeout(1500);
  return page;
}

async function main(): Promise<void> {
  const browser = await chromium.launch();

  for (const colorScheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme,
    });
    const page = await openPage(ctx);
    await shot(page, `desktop-${colorScheme}`);
    // Expand the technical disclosure for a second capture.
    const summary = page.getByText("Technical details");
    if (await summary.count()) {
      await summary.first().click();
      await page.waitForTimeout(400);
      await shot(page, `desktop-${colorScheme}-details`);
    }
    await ctx.close();
  }

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const mobilePage = await openPage(mobile);
  await shot(mobilePage, "mobile");
  await mobile.close();

  await browser.close();
}

await main();
