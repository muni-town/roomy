/**
 * E2E stack launcher.
 *
 * Boots the whole app-lite stack hermetically — no docker, no real PDS, no
 * network — and blocks until Playwright tears it down:
 *
 *   1. **Stub PDS** (`pds-stub.ts`) on a fixed port, so the client's real
 *      `AtpAgent.login()` / service-auth path runs for real with no account.
 *   2. **Appserver** in-process via `createAppserver` with
 *      `APPSERVER_TEST_MODE=true` (`X-Test-Did` header auth), a throwaway
 *      `DATA_DIR`, and a no-op profile fetcher (no api.bsky.app calls).
 *   3. **Fixture rows** (`seed.ts`) into the appserver's own DB singletons.
 *   4. **app-lite** (`vite dev`) as a child process, pointed at the local
 *      appserver by `VITE_APPSERVER_WS_ORIGIN` — which drives both the sync
 *      WebSocket and the XRPC HTTP client.
 *
 * Playwright's `webServer` spawns this and waits for the app-lite origin to
 * answer. The browser cannot set `X-Test-Did` itself, so the spec fixture
 * injects it on appserver requests (see `spec-helpers.ts`); the appserver
 * authenticates on that header, not on the stub Bearer token.
 *
 * Runs on Bun (the appserver is a Bun server).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createAppserver } from "../../appserver/src/appserver.ts";
import { _setTestGetRoomyProfileRecord } from "../../appserver/src/materialization/roomyProfile.ts";
import { _setTestGetProfiles } from "../../appserver/src/queries/profileStore.ts";
import { startPdsStub } from "./pds-stub.ts";
import { seedFixture } from "./seed.ts";
import {
  APP_LITE_ORIGIN,
  APP_LITE_PORT,
  APPSERVER_DID,
  APPSERVER_PORT,
  APPSERVER_WS_ORIGIN,
  PDS_ORIGIN,
  TEST_USER_DID,
  TEST_USER_HANDLE,
} from "./fixtures.ts";

const APP_LITE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(APP_LITE_DIR));

/** Wait for an HTTP endpoint to answer, or throw after `timeoutMs`. */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      // Any HTTP answer proves the listener is up; health endpoints answer 200.
      if (resp.status < 500) return;
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${url} (${lastError})`);
}

const children: ChildProcess[] = [];

function shutdown(exitCode: number): void {
  for (const child of children) child.kill("SIGTERM");
  process.exit(exitCode);
}

async function main(): Promise<void> {
  // ── Throwaway data dir ───────────────────────────────────────────────
  // Must be set before the appserver opens its DBs (and before
  // `loadAppserverSigningKey` resolves the key path).
  const dataDir = mkdtempSync(join(tmpdir(), "roomy-e2e-"));
  process.env.DATA_DIR = dataDir;

  // ── Appserver, in test mode ──────────────────────────────────────────
  // `APPSERVER_TEST_MODE` and `RATE_LIMIT_DISABLED` are set by Playwright's
  // `webServer.env` (see `playwright.config.ts`) because the appserver reads
  // them at module-load time — before this script's body runs, since its
  // imports are evaluated first. Assert rather than silently re-set, so a
  // config regression surfaces here instead of as confusing 401/429s.
  if (process.env.APPSERVER_TEST_MODE !== "true") {
    throw new Error(
      "launch-stack: APPSERVER_TEST_MODE must be set by the Playwright webServer env",
    );
  }
  if (process.env.RATE_LIMIT_DISABLED !== "true") {
    throw new Error(
      "launch-stack: RATE_LIMIT_DISABLED must be set by the Playwright webServer env",
    );
  }

  const pds = startPdsStub();

  // Keep every profile lookup in-process, the same way the appserver's own
  // e2e helpers do (`src/e2e/helpers.ts`). Without these the `getProfile`
  // handler's PDS-first branch resolves the DID through https://plc.directory
  // and then calls the user's PDS — a real network dependency inside the
  // suite. Stubbed, the handler falls through to the seeded global profile
  // row, which is what the specs assert on.
  _setTestGetProfiles(async () => []);
  _setTestGetRoomyProfileRecord(async () => null);

  const appserver = await createAppserver({
    port: APPSERVER_PORT,
    ownDid: APPSERVER_DID,
    serviceEndpoint: `http://127.0.0.1:${APPSERVER_PORT}`,
    dbPath: join(dataDir, "roomy-events.sqlite"),
    readStateDbPath: join(dataDir, "roomy-readstate.sqlite"),
    corsOrigin: "*",
    quiet: true,
    // Belt-and-braces with the stubs above: the materialiser's own hydration
    // leg takes this fetcher, so nothing reaches api.bsky.app either.
    getProfiles: async () => [],
    // HappyView / arbiter / Qdrant / Polar are all left unconfigured —
    // each is a no-op without its env vars.
  });

  const appserverOrigin = `http://127.0.0.1:${appserver.port}`;
  await waitForHttp(`${appserverOrigin}/health`, 20_000);

  // ── Fixtures ─────────────────────────────────────────────────────────
  await seedFixture(appserverOrigin);

  // ── app-lite (vite dev) ──────────────────────────────────────────────
  // `VITE_*` vars reach `import.meta.env` (inlined by vite);
  // `PUBLIC_*` vars reach `$env/dynamic/public` (read at runtime by SvelteKit).
  const vite = spawn(
    "pnpm",
    [
      "--filter",
      "app-lite",
      "exec",
      "vite",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(APP_LITE_PORT),
    ],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_APPSERVER_DID: APPSERVER_DID,
        VITE_APPSERVER_WS_ORIGIN: APPSERVER_WS_ORIGIN,
        VITE_PORT: String(APP_LITE_PORT),
        // Test-mode client auth: the real app-password path, pointed at the
        // stub PDS so no network and no real account are involved.
        PUBLIC_TEST_IDENTIFIER: TEST_USER_DID,
        PUBLIC_TEST_APP_PASSWORD: "e2e-stub-password",
        PUBLIC_PDS: PDS_ORIGIN,
        PUBLIC_PDS_HANDLE_SUFFIX: ".roomy.test",
        // Links resolve to this origin instead of the public deployment.
        PUBLIC_WEB_ORIGIN: APP_LITE_ORIGIN,
        VITE_PUBLIC_WEB_ORIGIN: APP_LITE_ORIGIN,
      },
    },
  );
  children.push(vite);

  vite.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[e2e] app-lite exited with code ${code}`);
      shutdown(1);
    }
  });

  // ── Ready ────────────────────────────────────────────────────────────
  // Playwright waits on APP_LITE_ORIGIN; log readiness first so a startup
  // failure is readable in the webServer output.
  await waitForHttp(APP_LITE_ORIGIN, 90_000);
  console.log(
    `[e2e] ready — app-lite ${APP_LITE_ORIGIN}, appserver ${appserverOrigin}, pds ${pds.origin}, user ${TEST_USER_HANDLE}`,
  );

  // ── Teardown ─────────────────────────────────────────────────────────
  const close = async () => {
    for (const child of children) child.kill("SIGTERM");
    pds.stop();
    await appserver.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());

  // Block forever; Playwright kills this process when the run finishes.
  await new Promise<never>(() => {});
}

await main();
