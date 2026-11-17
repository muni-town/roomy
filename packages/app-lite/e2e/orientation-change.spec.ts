/**
 * The shell keeps its top bar on screen across an orientation change.
 *
 * A phone's layout viewport and its visible area are not the same box: the
 * browser's toolbars cover part of the latter while the page is upright. The
 * document therefore has to be sized from the dynamic viewport, and it has to
 * have no scroll slack, or the platform is free to scroll it during the
 * rotation — which is how the navbar ends up above the screen.
 *
 * Chromium cannot put the layout viewport and the visible area out of step the
 * way a phone does, so the rotation here exercises the invariant the sizing
 * establishes rather than the iOS trigger itself: at every phase the panel and
 * the navbar fill the viewport, the document has nothing to scroll, and the
 * scroll offset is zero.
 *
 * Safe-area insets are what make `env(safe-area-inset-*)` non-zero in the
 * desktop Chromium the suite runs, and they come from a CDP override: they
 * flip from the status bar (top in portrait) to the sides in landscape, so
 * both the inset and the viewport change at the same time, as they do on a
 * phone.
 */

import type { Page } from "@playwright/test";
import { test, expect, waitForAuthenticated } from "./spec-helpers.ts";
import { SEED_ROOM_PATH } from "./fixtures.ts";

type Insets = { top: number; bottom: number; left: number; right: number };

type Orientation = {
  name: string;
  width: number;
  height: number;
  insets: Insets;
};

/** iPhone-ish portrait: status bar at the top, home indicator at the bottom. */
const PORTRAIT: Orientation = {
  name: "portrait",
  width: 390,
  height: 844,
  insets: { top: 47, bottom: 34, left: 0, right: 0 },
};

/** The same device turned sideways: the inset moves to the left and right. */
const LANDSCAPE: Orientation = {
  name: "landscape",
  width: 844,
  height: 390,
  insets: { top: 0, bottom: 21, left: 47, right: 47 },
};

async function measureShell(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".main-panel") as HTMLElement | null;
    const navbar = panel
      ? (Array.from(panel.children).find((child) =>
          child.className.includes("shrink-0"),
        ) as HTMLElement | undefined)
      : undefined;
    if (!panel || !navbar) throw new Error("the shell is not mounted");
    const panelBox = panel.getBoundingClientRect();
    const navbarBox = navbar.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
      documentScrollHeight: document.documentElement.scrollHeight,
      documentClientHeight: document.documentElement.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      bodyClientHeight: document.body.clientHeight,
      bodyPaddingTop: parseFloat(getComputedStyle(document.body).paddingTop),
      panelTop: panelBox.top,
      panelHeight: panelBox.height,
      panelBottom: panelBox.bottom,
      navbarTop: navbarBox.top,
      navbarBottom: navbarBox.bottom,
    };
  });
}

test("the navbar stays on screen when the phone is rotated and turned back", async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  // `Emulation.setSafeAreaInsetsOverride` postdates the protocol typings
  // bundled with Playwright; the runtime accepts the documented params.
  const setSafeAreaInsets = (insets: Insets) =>
    (cdp.send as (method: string, params: unknown) => Promise<unknown>)(
      "Emulation.setSafeAreaInsetsOverride",
      { insets },
    );

  const applyOrientation = async ({ width, height, insets }: Orientation) => {
    await page.setViewportSize({ width, height });
    await setSafeAreaInsets(insets);
  };

  let overridesSupported = true;
  try {
    await setSafeAreaInsets(PORTRAIT.insets);
  } catch {
    overridesSupported = false;
  }
  test.skip(
    !overridesSupported,
    "this Chromium has no Emulation.setSafeAreaInsetsOverride",
  );

  await page.setViewportSize({
    width: PORTRAIT.width,
    height: PORTRAIT.height,
  });
  await page.goto(SEED_ROOM_PATH);
  await waitForAuthenticated(page);

  const phases = [PORTRAIT, LANDSCAPE, PORTRAIT];
  for (const [index, orientation] of phases.entries()) {
    await applyOrientation(orientation);
    // The layout is driven by CSS only; a frame is all it needs to settle.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    const shell = await measureShell(page);
    const at = `phase ${index} (${orientation.name}, ${shell.innerHeight}px)`;

    expect(shell.scrollY, `document scrolled ${at}`).toBe(0);
    expect(
      shell.documentScrollHeight,
      `document has scroll slack ${at}`,
    ).toBeLessThanOrEqual(shell.documentClientHeight);
    // A rotation is not the only thing that can move the document: anything
    // that asks for a scroll (the platform revealing a focused field, a
    // restored offset) gets one only if the document has somewhere to go.
    const scrollAttempt = await page.evaluate(() => {
      window.scrollTo(0, 10_000);
      const offset = window.scrollY;
      window.scrollTo(0, 0);
      return offset;
    });
    expect(
      scrollAttempt,
      `the document can be scrolled ${at}`,
    ).toBe(0);
    expect(
      shell.bodyScrollHeight,
      `body has scroll slack ${at}`,
    ).toBeLessThanOrEqual(shell.bodyClientHeight);

    // The panel starts exactly where the body's status-bar padding ends and
    // ends at the bottom of the visible area.
    expect(
      Math.abs(shell.panelTop - shell.bodyPaddingTop),
      `panel is not aligned with the safe-area inset ${at}`,
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(shell.panelBottom - shell.innerHeight),
      `panel does not reach the bottom of the visible area ${at}`,
    ).toBeLessThanOrEqual(0.5);

    // The navbar is the top bar: fully inside the visible area.
    expect(
      shell.navbarTop,
      `navbar starts above the screen ${at}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      shell.navbarBottom,
      `navbar ends below the visible area ${at}`,
    ).toBeLessThanOrEqual(shell.innerHeight);
  }
});
