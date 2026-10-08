/**
 * Capture the multi-select message action UI.
 *
 * Not a spec: this script drives the same hermetic stack the E2E suite uses
 * (see `launch-stack.ts`) and writes PNGs of the select-mode surface, so a
 * design change to it can be reviewed and diffed as images. It asserts
 * nothing; a failed step throws.
 *
 *   bun run e2e/launch-stack.ts          # in one shell
 *   bun run e2e/capture-select-ui.ts     # in another
 *
 * Output: `e2e/screenshots/<label>-<n>-<name>.png`, where `<label>` is the
 * first CLI argument (default "before") — e.g. `after` after a change, so the
 * two runs sit side by side under one prefix.
 */

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  APP_LITE_ORIGIN,
  SEED_LINK_MESSAGE_URL,
  SEED_MESSAGE_TEXT,
  SEED_ROOM_PATH,
  SEED_SPACE_3_MESSAGE_TEXT,
  SEED_SPACE_3_ROOM_PATH,
} from "./fixtures.ts";
import { installTestAuth, waitForAuthenticated } from "./spec-helpers.ts";

const label = process.argv[2] ?? "before";
const OUT_DIR = join(import.meta.dirname, "screenshots");
mkdirSync(OUT_DIR, { recursive: true });

let step = 0;
async function shot(page: Page, name: string): Promise<void> {
  step += 1;
  const file = join(
    OUT_DIR,
    `${label}-${String(step).padStart(2, "0")}-${name}.png`,
  );
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`);
}

/** Enter select mode from a message's hover toolbar. */
async function startSelectFrom(page: Page, text: string): Promise<void> {
  await page.getByText(text).first().hover();
  await page.getByLabel("More actions").first().click();
  await page.getByRole("menuitem", { name: "Select", exact: true }).click();
  await page.getByText(/^\d+ selected$/).waitFor();
}

/** The checkbox row for a specific message. */
function messageRow(page: Page, text: string) {
  return page
    .getByRole("checkbox", { name: "Select message" })
    .filter({ hasText: text });
}

/** Select the second lobby message, so the bar shows a real multi-selection. */
async function selectSecondMessage(page: Page): Promise<void> {
  // `worth saving` is the link message's body; the link preview card repeats
  // the URL, so address the row by its text, not by the fixture constant.
  await messageRow(page, "worth saving").click();
}

async function openRoom(ctx: BrowserContext, path: string): Promise<Page> {
  const page = await ctx.newPage();
  await installTestAuth(page);
  await page.goto(`${APP_LITE_ORIGIN}${path}`);
  await waitForAuthenticated(page);
  return page;
}

async function main(): Promise<void> {
  const browser = await chromium.launch();

  // ── Desktop ───────────────────────────────────────────────────────────
  for (const colorScheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      colorScheme,
    });
    const page = await openRoom(ctx, SEED_ROOM_PATH);
    await startSelectFrom(page, SEED_MESSAGE_TEXT);
    await shot(page, `one-selected-${colorScheme}`);
    await selectSecondMessage(page);
    await shot(page, `two-selected-${colorScheme}`);

    // The third space's message is authored by someone else and the viewer is
    // a plain member: the same bar without the admin-only actions.
    const memberPage = await openRoom(ctx, SEED_SPACE_3_ROOM_PATH);
    await startSelectFrom(memberPage, SEED_SPACE_3_MESSAGE_TEXT);
    await shot(memberPage, `member-one-selected-${colorScheme}`);
    await ctx.close();
  }

  // ── Mobile (coarse pointer, touch) ────────────────────────────────────
  // A coarse pointer + long-press is the mobile entry (ChatMessage's
  // `handleContextAction`), not the hover toolbar.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const mobilePage = await openRoom(mobile, SEED_ROOM_PATH);
  // A coarse pointer has no hover, so the toolbar is summoned by a long press
  // (`ChatMessage`'s `handleContextAction`, bound to `contextmenu`). Playwright
  // has no long-press gesture, so the event the press produces is dispatched
  // directly on the message.
  const target = mobilePage.getByText(SEED_MESSAGE_TEXT).first();
  await target.scrollIntoViewIfNeeded();
  await target.dispatchEvent("contextmenu");
  await mobilePage.getByText(/^\d+ selected$/).waitFor();
  await shot(mobilePage, "one-selected-mobile");
  await selectSecondMessage(mobilePage);
  await shot(mobilePage, "two-selected-mobile");
  await mobile.close();

  await browser.close();
}

await main();

// Referenced so the fixture import list stays honest about what this script
// depends on.
void SEED_LINK_MESSAGE_URL;
