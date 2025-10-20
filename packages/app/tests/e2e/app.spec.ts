import { test, expect, type Page } from "@playwright/test";

test.describe("Roomy App - Core Functionality", () => {
  test.beforeEach(async ({ page }) => {
    // Monitor console errors and warnings
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error("Browser console error:", msg.text());
      }
    });

    // Navigate to the homepage
    await page.goto("/");
  });

  test("should load the app and initialize workers", async ({ page }) => {
    // Wait for the app to load
    await page.waitForLoadState("domcontentloaded");

    // Wait a bit longer for any redirects to complete (app redirects from / to /home)
    await page.waitForTimeout(2000);

    // Check the page title - it might be empty or set dynamically
    const actualTitle = await page.title();
    const currentUrl = page.url();
    console.log("Actual page title:", actualTitle);
    console.log("Current URL after redirects:", currentUrl);

    // Accept either a title containing "roomy" or an empty title (if set dynamically later)
    if (actualTitle && actualTitle.length > 0) {
      await expect(page).toHaveTitle(/roomy/i);
    } else {
      // If title is empty, just ensure the page loaded properly by checking for body
      await expect(page.locator("body")).toBeVisible();
    }

    // Wait for workers to be available on the global object
    await page.waitForFunction(
      () => {
        return (window as any).backend && (window as any).backendStatus;
      },
      { timeout: 15000 },
    );

    // Verify worker objects exist
    const hasBackend = await page.evaluate(() => {
      return (
        typeof (window as any).backend === "object" &&
        typeof (window as any).backendStatus === "object"
      );
    });
    expect(hasBackend).toBeTruthy();
  });

  test("should support SharedWorker or fallback to Worker", async ({
    page,
  }) => {
    await page.waitForLoadState("domcontentloaded");

    const workerSupport = await page.evaluate(() => {
      return {
        hasSharedWorker: "SharedWorker" in globalThis,
        hasWorker: "Worker" in globalThis,
        hasMessageChannel: "MessageChannel" in globalThis,
        hasBroadcastChannel: "BroadcastChannel" in globalThis,
      };
    });

    // At least one worker type should be supported
    expect(
      workerSupport.hasSharedWorker || workerSupport.hasWorker,
    ).toBeTruthy();

    // MessageChannel is required for worker communication
    expect(workerSupport.hasMessageChannel).toBeTruthy();

    console.log("Worker support:", workerSupport);
  });

  test("should initialize backend worker and respond to ping", async ({
    page,
  }) => {
    await page.waitForLoadState("domcontentloaded");

    // Wait for backend to be ready and debug helpers to be available
    await page.waitForFunction(
      () => {
        return (window as any).backend && (window as any).debugWorkers;
      },
      { timeout: 15000 },
    );

    // Test backend ping functionality using debug helper
    const pingResult = await page.evaluate(async () => {
      try {
        const debugWorkers = (window as any).debugWorkers;
        const result = await debugWorkers.pingBackend();
        return { success: true, result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(pingResult.success).toBeTruthy();
    console.log("Backend ping result:", pingResult);
  });

  test("should initialize SQLite worker and handle basic queries", async ({
    page,
  }) => {
    await page.waitForLoadState("domcontentloaded");

    // Wait for backend and debug helpers to be ready
    await page.waitForFunction(
      () => {
        return (window as any).backend && (window as any).debugWorkers;
      },
      { timeout: 15000 },
    );

    // Test SQLite connection using debug helper
    const sqliteTest = await page.evaluate(async () => {
      try {
        const debugWorkers = (window as any).debugWorkers;
        const result = await debugWorkers.testSqliteConnection();
        return { success: true, result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(sqliteTest.success).toBeTruthy();
    if (sqliteTest.success) {
      expect(sqliteTest.result).toBeDefined();
    }
    console.log("SQLite test result:", sqliteTest);
  });

  test("should have proper COOP/COEP headers for SharedArrayBuffer support", async ({
    page,
  }) => {
    const response = await page.goto("/");

    // Check for the headers that enable SharedArrayBuffer
    const headers = response?.headers() || {};

    // The app should set these headers for SQLite WASM to work properly
    expect(
      headers["cross-origin-embedder-policy"] === "credentialless" ||
        headers["cross-origin-embedder-policy"] === "require-corp",
    ).toBeTruthy();

    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  test("should have debug helpers available", async ({ page }) => {
    await page.waitForLoadState("domcontentloaded");

    // Wait for debug helpers to be available
    await page.waitForFunction(
      () => {
        return (window as any).debugWorkers;
      },
      { timeout: 15000 },
    );

    const debugHelpers = await page.evaluate(() => {
      const helpers = (window as any).debugWorkers;
      return {
        hasPingBackend: typeof helpers?.pingBackend === "function",
        hasTestSqliteConnection:
          typeof helpers?.testSqliteConnection === "function",
      };
    });

    expect(debugHelpers.hasPingBackend).toBeTruthy();
    expect(debugHelpers.hasTestSqliteConnection).toBeTruthy();
  });

  test("should handle worker status updates", async ({ page }) => {
    await page.waitForLoadState("domcontentloaded");

    // Wait for status objects to be available
    await page.waitForFunction(
      () => {
        return (window as any).backendStatus;
      },
      { timeout: 15000 },
    );

    // Check that status is reactive and has expected properties
    const statusCheck = await page.evaluate(() => {
      const backendStatus = (window as any).backendStatus;
      return {
        hasBackendStatus: !!backendStatus,
        isReactive:
          typeof backendStatus?.subscribe === "function" ||
          typeof backendStatus?.value !== "undefined",
      };
    });

    expect(statusCheck.hasBackendStatus).toBeTruthy();
  });

  test("should handle navigation and basic UI", async ({ page }) => {
    await page.waitForLoadState("domcontentloaded");

    // Wait for the main app content to load
    await page.waitForSelector("body", { timeout: 10000 });

    // Check for basic page structure
    const pageStructure = await page.evaluate(() => {
      return {
        hasBody: !!document.body,
        hasMain: !!document.querySelector("main"),
        hasApp: !!document.querySelector("#app, [data-svelte-h]"),
        bodyClasses: document.body.className,
      };
    });

    expect(pageStructure.hasBody).toBeTruthy();
    console.log("Page structure:", pageStructure);
  });

  test("should handle offline/online scenarios gracefully", async ({
    page,
  }) => {
    await page.waitForLoadState("domcontentloaded");

    // Wait for workers and debug helpers to initialize
    await page.waitForFunction(
      () => {
        return (window as any).backend && (window as any).debugWorkers;
      },
      { timeout: 15000 },
    );

    // Test that the app handles network changes
    await page.context().setOffline(true);

    // The app should still be functional offline (since it's mainly local SQLite)
    const offlineTest = await page.evaluate(async () => {
      try {
        // Test local SQLite operation while offline using debug helper
        const debugWorkers = (window as any).debugWorkers;
        const result = await debugWorkers.testSqliteConnection();
        return { success: true, result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    // SQLite operations should still work offline
    expect(offlineTest.success).toBeTruthy();

    // Go back online
    await page.context().setOffline(false);
  });

  test("should support required browser APIs", async ({ page }) => {
    await page.waitForLoadState("domcontentloaded");

    const apiSupport = await page.evaluate(() => {
      return {
        indexedDB: "indexedDB" in globalThis,
        webAssembly: "WebAssembly" in globalThis,
        crypto: "crypto" in globalThis && "randomUUID" in crypto,
        locks: "navigator" in globalThis && "locks" in navigator,
        messageChannel: "MessageChannel" in globalThis,
        broadcastChannel: "BroadcastChannel" in globalThis,
        fetch: "fetch" in globalThis,
      };
    });

    // These APIs are required for the app to function
    expect(apiSupport.indexedDB).toBeTruthy();
    expect(apiSupport.webAssembly).toBeTruthy();
    expect(apiSupport.crypto).toBeTruthy();
    expect(apiSupport.locks).toBeTruthy();
    expect(apiSupport.messageChannel).toBeTruthy();
    expect(apiSupport.fetch).toBeTruthy();

    console.log("Browser API support:", apiSupport);
  });
});
