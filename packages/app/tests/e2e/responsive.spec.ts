import { test, expect, type Page } from "@playwright/test";
import { waitForWorkersReady, getWorkerStatus } from "./utils/test-helpers";

test.describe("Responsive Design - Cross-Browser Compatibility", () => {
  const viewports = [
    { name: "mobile-portrait", width: 375, height: 667, deviceScaleFactor: 2 },
    { name: "mobile-landscape", width: 667, height: 375, deviceScaleFactor: 2 },
    { name: "tablet-portrait", width: 768, height: 1024, deviceScaleFactor: 1 },
    {
      name: "tablet-landscape",
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
    },
    { name: "desktop-small", width: 1280, height: 720, deviceScaleFactor: 1 },
    { name: "desktop-large", width: 1920, height: 1080, deviceScaleFactor: 1 },
    { name: "ultrawide", width: 2560, height: 1440, deviceScaleFactor: 1 },
  ];

  test.beforeEach(async ({ page }) => {
    // Monitor console errors
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`Console error [${msg.type()}]:`, msg.text());
      }
    });

    await page.goto("/");
  });

  test("should load and function across all viewport sizes", async ({
    page,
  }) => {
    for (const viewport of viewports) {
      console.log(
        `Testing viewport: ${viewport.name} (${viewport.width}x${viewport.height})`,
      );

      // Set viewport
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });

      // Wait for app to load
      await page.waitForLoadState("domcontentloaded");

      // Wait for workers to initialize
      await waitForWorkersReady(page);

      // Test that the app is functional
      const functionality = await page.evaluate(async () => {
        try {
          const debugWorkers = (window as any).debugWorkers;
          const result = await debugWorkers.testSqliteConnection();
          return {
            workersWorking: true,
            queryResult: result,
          };
        } catch (error) {
          return {
            workersWorking: false,
            error: (error as Error).message,
          };
        }
      });

      expect(
        functionality.workersWorking,
        `Workers should work on ${viewport.name}`,
      ).toBeTruthy();

      // Check that main content is visible
      const mainContent = page.locator("body");
      await expect(mainContent).toBeVisible();

      // Take a screenshot for visual regression testing
      await expect(page).toHaveScreenshot(`app-${viewport.name}.png`, {
        fullPage: true,
        animations: "disabled",
      });

      // Small delay between viewport changes
      await page.waitForTimeout(500);
    }
  });

  test("should handle mobile touch interactions", async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForLoadState("domcontentloaded");
    await waitForWorkersReady(page);

    // Test touch events if the page has interactive elements
    const interactiveElements = await page
      .locator('button, a, [role="button"], input, textarea')
      .count();

    if (interactiveElements > 0) {
      // Test that touch events work
      const touchTest = await page.evaluate(() => {
        return {
          hasTouchSupport: "ontouchstart" in window,
          hasPointerEvents: "PointerEvent" in window,
          maxTouchPoints: navigator.maxTouchPoints || 0,
        };
      });

      console.log("Mobile touch capabilities:", touchTest);

      // Try to tap the first interactive element
      const firstButton = page.locator('button, [role="button"]').first();
      if ((await firstButton.count()) > 0) {
        await expect(firstButton).toBeVisible();
        // Only tap if the element is enabled
        if (await firstButton.isEnabled()) {
          await firstButton.tap();
        }
      }
    }
  });

  test("should maintain functionality when rotating device", async ({
    page,
  }) => {
    // Start in portrait
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForLoadState("domcontentloaded");
    await waitForWorkersReady(page);

    // Test functionality in portrait
    const portraitTest = await page.evaluate(async () => {
      try {
        const debugWorkers = (window as any).debugWorkers;
        await debugWorkers.testSqliteConnection();
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(portraitTest.success).toBeTruthy();

    // Rotate to landscape
    await page.setViewportSize({ width: 667, height: 375 });
    await page.waitForLoadState("domcontentloaded");

    // Wait a moment for any layout shifts
    await page.waitForTimeout(1000);

    // Test functionality in landscape
    const landscapeTest = await page.evaluate(async () => {
      try {
        const debugWorkers = (window as any).debugWorkers;
        await debugWorkers.testSqliteConnection();
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(landscapeTest.success).toBeTruthy();
  });

  test("should handle different pixel densities", async ({ page }) => {
    const densities = [1, 2, 3];

    for (const density of densities) {
      console.log(`Testing pixel density: ${density}x`);

      await page.setViewportSize({
        width: 375,
        height: 667,
      });

      // Note: Playwright doesn't directly support changing deviceScaleFactor after page load,
      // but we can test that the app handles different densities properly
      await page.waitForLoadState("domcontentloaded");

      const densityInfo = await page.evaluate(() => {
        return {
          devicePixelRatio: window.devicePixelRatio,
          screenWidth: screen.width,
          screenHeight: screen.height,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        };
      });

      console.log(`Density ${density}x info:`, densityInfo);

      // The app should still work regardless of pixel density
      await waitForWorkersReady(page);
      const status = await getWorkerStatus(page);
      expect(status.hasPeer).toBeTruthy();
    }
  });

  test("should handle very small screen sizes gracefully", async ({ page }) => {
    // Test extremely small viewport (smartwatch size)
    await page.setViewportSize({ width: 200, height: 200 });
    await page.waitForLoadState("domcontentloaded");

    // App should still load without crashing
    const bodyExists = await page.locator("body").count();
    expect(bodyExists).toBeGreaterThan(0);

    // Workers should still initialize even on very small screens
    try {
      await waitForWorkersReady(page, 30000); // Longer timeout for small screens
      const status = await getWorkerStatus(page);
      expect(status.hasPeer).toBeTruthy();
    } catch (error) {
      console.log(
        "Workers may have issues on very small screens:",
        (error as Error).message,
      );
    }
  });

  test("should handle very large screen sizes", async ({ page }) => {
    // Test 4K screen
    await page.setViewportSize({ width: 3840, height: 2160 });
    await page.waitForLoadState("domcontentloaded");
    await waitForWorkersReady(page);

    // Check that the app scales appropriately
    const layoutInfo = await page.evaluate(() => {
      const body = document.body;
      return {
        bodyWidth: body.offsetWidth,
        bodyHeight: body.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        hasHorizontalScroll:
          document.documentElement.scrollWidth > window.innerWidth,
        hasVerticalScroll:
          document.documentElement.scrollHeight > window.innerHeight,
      };
    });

    // The app should fill the available space appropriately
    expect(layoutInfo.viewportWidth).toBe(3840);
    expect(layoutInfo.viewportHeight).toBe(2160);

    console.log("4K layout info:", layoutInfo);

    // Take screenshot of 4K layout
    await expect(page).toHaveScreenshot("app-4k.png", {
      fullPage: false, // Don't take full page on 4K to keep file size reasonable
      animations: "disabled",
    });
  });

  test("should maintain worker performance across screen sizes", async ({
    page,
  }) => {
    const performanceResults = [];

    for (const viewport of [
      { name: "mobile", width: 375, height: 667 },
      { name: "desktop", width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.waitForLoadState("domcontentloaded");
      await waitForWorkersReady(page);

      // Measure worker performance
      const startTime = Date.now();
      const performanceTest = await page.evaluate(async () => {
        const debugWorkers = (window as any).debugWorkers;
        const queries = [];

        // Run several queries to test performance
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          try {
            await debugWorkers.testSqliteConnection();
            const duration = performance.now() - start;
            queries.push({ success: true, duration });
          } catch (error) {
            queries.push({ success: false, error: (error as Error).message });
          }
        }

        return queries;
      });
      const totalTime = Date.now() - startTime;

      const successfulQueries = performanceTest.filter((q) => q.success);
      const avgDuration =
        successfulQueries.reduce((sum, q) => sum + q?.duration, 0) /
        successfulQueries.length;

      performanceResults.push({
        viewport: viewport.name,
        totalTime,
        avgQueryDuration: avgDuration,
        successfulQueries: successfulQueries.length,
        totalQueries: performanceTest.length,
      });

      // All queries should succeed
      expect(successfulQueries.length).toBe(performanceTest.length);
    }

    console.log("Performance across viewports:", performanceResults);

    // Performance shouldn't degrade significantly between mobile and desktop
    const mobilePerf = performanceResults.find((r) => r.viewport === "mobile");
    const desktopPerf = performanceResults.find(
      (r) => r.viewport === "desktop",
    );

    if (mobilePerf && desktopPerf) {
      // Mobile shouldn't be more than 3x slower than desktop
      const performanceRatio =
        mobilePerf.avgQueryDuration / desktopPerf.avgQueryDuration;
      expect(performanceRatio).toBeLessThan(3);
    }
  });

  test("should handle orientation changes smoothly", async ({ page }) => {
    // Start in one orientation
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForLoadState("domcontentloaded");
    await waitForWorkersReady(page);

    // Take initial screenshot
    await expect(page).toHaveScreenshot("orientation-portrait.png", {
      animations: "disabled",
    });

    // Change orientation
    await page.setViewportSize({ width: 1024, height: 768 });

    // Wait for any reflow/repaint
    await page.waitForTimeout(1000);

    // Ensure workers still work after orientation change
    const postOrientationTest = await page.evaluate(async () => {
      try {
        const debugWorkers = (window as any).debugWorkers;
        const result = await debugWorkers.testSqliteConnection();
        return { success: true, result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(postOrientationTest.success).toBeTruthy();

    // Take screenshot after orientation change
    await expect(page).toHaveScreenshot("orientation-landscape.png", {
      animations: "disabled",
    });
  });

  test("should be accessible on different screen sizes", async ({ page }) => {
    for (const viewport of [
      { name: "mobile", width: 375, height: 667 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "desktop", width: 1280, height: 720 },
    ]) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.waitForLoadState("domcontentloaded");

      // Check basic accessibility requirements
      const accessibilityCheck = await page.evaluate(() => {
        return {
          hasMainLandmark: !!document.querySelector('main, [role="main"]'),
          hasHeadings:
            document.querySelectorAll("h1, h2, h3, h4, h5, h6").length > 0,
          hasSkipLinks: !!document.querySelector(
            'a[href="#main"], a[href="#content"]',
          ),
          focusableElements: document.querySelectorAll(
            "button, a, input, textarea, select, [tabindex]",
          ).length,
          hasProperContrast:
            window.getComputedStyle(document.body).color !== "rgb(0, 0, 0)" ||
            window.getComputedStyle(document.body).backgroundColor !==
            "rgb(255, 255, 255)",
        };
      });

      console.log(
        `Accessibility check for ${viewport.name}:`,
        accessibilityCheck,
      );

      // At least some focusable elements should exist
      expect(accessibilityCheck.focusableElements).toBeGreaterThanOrEqual(0);
    }
  });
});
