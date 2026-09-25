import { defineConfig, devices } from "@playwright/test";
import { APP_LITE_ORIGIN, APP_LITE_PORT } from "./e2e/fixtures.ts";

/**
 * Playwright config for app-lite end-to-end tests.
 *
 * Lives in `packages/app-lite` rather than the repo root because the suite
 * tests that package: it needs app-lite's vite dev server, its `.env`-style
 * `PUBLIC_*` runtime vars, and the appserver it pairs with. Both the config
 * and the specs sit beside the code they cover. (The repo root has no
 * test runner for any package — each package owns its own.)
 *
 * The stack is fully hermetic and started by `e2e/launch-stack.ts`:
 * a stub PDS, an in-process appserver in `APPSERVER_TEST_MODE`, seeded
 * fixtures, and `vite dev`. No docker, no real PDS, no network — see that
 * file for why. `webServer` waits on the app-lite origin before any test runs.
 */
export default defineConfig({
  testDir: "./e2e",
  // Only `*.spec.ts` are tests; the launcher/seed/stub modules are helpers.
  testMatch: "**/*.spec.ts",
  // The seeded world is shared and the appserver is a single process, so runs
  // are serial by default. Tests are written not to interfere with each
  // other's data anyway (they add their own messages/rooms).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: APP_LITE_ORIGIN,
    // Failure diagnostics: traces and screenshots land in test-results/ and
    // are uploaded as a CI artifact.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // Playwright runs this with cwd = this config's directory
    // (`packages/app-lite`), so the path is relative to the package.
    command: "bun run e2e/launch-stack.ts",
    url: APP_LITE_ORIGIN,
    // `url` (not `port`) so readiness means "app-lite answered HTTP", not
    // merely "something bound the socket".
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Set here, not inside the launcher: these are read at module-load time
      // by the appserver (the rate limiter reads its switch once, at import),
      // so they must be in the process environment before any module is
      // evaluated — a static import in the launcher runs before its own body.
      //
      // `APPSERVER_TEST_MODE` selects the `X-Test-Did` auth verifier; every
      // request in the run originates from 127.0.0.1, so the default
      // 100-requests/60s per-IP limit would be exhausted partway through a
      // suite and surface as 429s.
      APPSERVER_TEST_MODE: "true",
      RATE_LIMIT_DISABLED: "true",
      E2E_APP_LITE_PORT: String(APP_LITE_PORT),
    },
  },
});
