import { test, expect } from '@playwright/test';

test.describe('Roomy App - Smoke Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('should load app and initialize workers', async ({ page }) => {
    // Check that page loaded by verifying body exists (not visibility due to loading overlay)
    await expect(page.locator('body')).toBeAttached();

    // Wait for workers to be available
    await page.waitForFunction(() => {
      return (window as any).backend &&
        (window as any).backendStatus &&
        (window as any).debugWorkers;
    }, { timeout: 20000 });

    // Verify worker objects exist
    const workerStatus = await page.evaluate(() => {
      return {
        hasBackend: typeof (window as any).backend === 'object',
        hasBackendStatus: typeof (window as any).backendStatus === 'object',
        hasDebugWorkers: typeof (window as any).debugWorkers === 'object',
      };
    });

    expect(workerStatus.hasBackend).toBeTruthy();
    expect(workerStatus.hasBackendStatus).toBeTruthy();
    expect(workerStatus.hasDebugWorkers).toBeTruthy();
  });

  test('should support required browser APIs', async ({ page }) => {
    const apiSupport = await page.evaluate(() => {
      return {
        worker: 'Worker' in globalThis,
        sharedWorker: 'SharedWorker' in globalThis,
        messageChannel: 'MessageChannel' in globalThis,
        indexedDB: 'indexedDB' in globalThis,
        webAssembly: 'WebAssembly' in globalThis,
        locks: 'locks' in navigator,
        crypto: 'crypto' in globalThis && 'randomUUID' in crypto,
      };
    });

    // Critical APIs must be supported
    expect(apiSupport.worker).toBeTruthy();
    expect(apiSupport.messageChannel).toBeTruthy();
    expect(apiSupport.indexedDB).toBeTruthy();
    expect(apiSupport.webAssembly).toBeTruthy();
    expect(apiSupport.locks).toBeTruthy();
    expect(apiSupport.crypto).toBeTruthy();

    console.log('Browser API support:', apiSupport);
  });

  test('should ping backend worker successfully', async ({ page }) => {
    // Wait for debug workers to be available
    await page.waitForFunction(() => {
      return (window as any).debugWorkers;
    }, { timeout: 20000 });

    // Test backend ping
    const pingResult = await page.evaluate(async () => {
      try {
        const result = await (window as any).debugWorkers.pingBackend();
        return { success: true, result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(pingResult.success).toBeTruthy();
    console.log('Backend ping result:', pingResult.result);
  });

  test('should connect to SQLite database', async ({ page }) => {
    // Wait for debug workers to be available
    await page.waitForFunction(() => {
      return (window as any).debugWorkers;
    }, { timeout: 20000 });

    // Test SQLite connection
    const sqliteResult = await page.evaluate(async () => {
      try {
        const result = await (window as any).debugWorkers.testSqliteConnection();
        return { success: true, result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    });

    expect(sqliteResult.success).toBeTruthy();
    console.log('SQLite test result:', sqliteResult.result);
  });

  test('should handle basic responsive layout', async ({ page }) => {
    // Test desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('body')).toBeAttached();

    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('body')).toBeAttached();

    await page.waitForFunction(() => {
      return (window as any).debugWorkers;
    }, { timeout: 10000 });

    // Test that workers still work after viewport change
    const workersStillWork = await page.evaluate(() => {
      return (window as any).backend && (window as any).debugWorkers;
    });

    expect(workersStillWork).toBeTruthy();
  });

  test('should have proper security headers', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response?.headers() || {};

    // Check for headers needed for SharedArrayBuffer
    const hasCoep = headers['cross-origin-embedder-policy'] === 'credentialless' ||
      headers['cross-origin-embedder-policy'] === 'require-corp';
    const hasCoop = headers['cross-origin-opener-policy'] === 'same-origin';

    expect(hasCoep).toBeTruthy();
    expect(hasCoop).toBeTruthy();

    console.log('Security headers:', {
      'cross-origin-embedder-policy': headers['cross-origin-embedder-policy'],
      'cross-origin-opener-policy': headers['cross-origin-opener-policy']
    });
  });
});