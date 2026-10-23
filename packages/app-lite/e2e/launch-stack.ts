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
import type { RoomyProfileRecord } from "../../appserver/src/materialization/roomyProfile.ts";
import { _setTestGetProfiles } from "../../appserver/src/queries/profileStore.ts";
import {
  _resetQdrantClient,
  _setQdrantClientForTest,
} from "../../appserver/src/search/qdrantSearch.ts";
import { startPdsStub, stubGetRecord } from "./pds-stub.ts";
import { seedFixture } from "./seed.ts";
import { FakeQdrant } from "./fake-qdrant.ts";
import {
  SEED_SEARCH_MESSAGE_ID,
  SEED_SEARCH_MESSAGE_TERM,
  SEED_SEARCH_THREAD_MESSAGE_ID,
  SEED_SEARCH_THREAD_MESSAGE_TERM,
  SEED_SPACE_ID,
  APP_LITE_ORIGIN,
  APP_LITE_PORT,
  APPSERVER_DID,
  APPSERVER_PORT,
  APPSERVER_WS_ORIGIN,
  OTHER_USER_DID,
  PDS_ORIGIN,
  TEST_ADMIN_DID,
  TEST_NON_MEMBER_DID,
  TEST_USER_DID,
  TEST_USER_HANDLE,
} from "./fixtures.ts";

const APP_LITE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(APP_LITE_DIR));

/** The real directory the appserver resolves `did:plc:` accounts through. */
const PLC_ORIGIN = "https://plc.directory";

/** The collection + rkey a user's Roomy profile record lives at. */
const PROFILE_COLLECTION = "space.roomy.user.profile";
const PROFILE_RKEY = "self";

/**
 * Answer the appserver's PLC lookups for the fixture DIDs, in-process.
 *
 * The fixture DIDs are fake, so the real directory has no document for them
 * and every DID a handler resolves fails before it reaches the PDS. That is
 * invisible for most reads — their data is seeded straight into the DBs — but
 * a block is read from the *viewer's own repo*, which means the appserver has
 * to resolve the viewer's DID and call the PDS it names. Without a document the
 * block set always looks empty and the feature cannot be exercised in the
 * browser at all.
 *
 * Every fixture DID therefore resolves to the stub PDS. Anything else, and any
 * other URL, passes through untouched: this exists to close the loop for the
 * seeded world, not to stand in for the directory.
 */
function stubFixtureDidDocuments(): void {
  const fixtureDids = new Set([
    TEST_USER_DID,
    OTHER_USER_DID,
    TEST_ADMIN_DID,
    TEST_NON_MEMBER_DID,
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${PLC_ORIGIN}/`)) {
      const did = decodeURIComponent(url.slice(PLC_ORIGIN.length + 1).split("/")[0] ?? "");
      if (fixtureDids.has(did)) {
        return Response.json({
          id: did,
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: PDS_ORIGIN,
            },
          ],
        });
      }
    }
    return realFetch(input as never, init);
  }) as typeof globalThis.fetch;
}

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

/**
 * Wait until a seeded message is findable through the search endpoint.
 *
 * The index is filled by the appserver's background indexer, which drains the
 * queue asynchronously; polling here means every spec starts against a warm
 * index and no spec has to synchronise on one. Throws rather than continuing
 * so a broken fake/search wiring surfaces as a launcher failure, not as
 * specs timing out one by one.
 */
async function waitForSearchIndex(
  origin: string,
  term: string,
  messageId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const url = `${origin}/xrpc/space.roomy.search.messages?spaceId=${SEED_SPACE_ID}&q=${term}`;
  const deadline = Date.now() + timeoutMs;
  let lastResult = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, {
        headers: { "X-Test-Did": TEST_USER_DID },
      });
      if (resp.ok) {
        const body = (await resp.json()) as {
          messages?: Array<{ id: string }>;
        };
        if (body.messages?.some((m) => m.id === messageId)) return;
        lastResult = `${body.messages?.length ?? 0} hits`;
      } else {
        lastResult = `HTTP ${resp.status}`;
      }
    } catch (err) {
      lastResult = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out waiting for ${messageId} to be searchable as "${term}" (${lastResult})`,
  );
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

  stubFixtureDidDocuments();
  // Keep the Bluesky handle lookup in-process, the same way the appserver's own
  // e2e helpers do (`src/e2e/helpers.ts`). Without it the `getProfile` handler's
  // on-demand hydration fetches api.bsky.app — a real network dependency inside
  // the suite. `getProfile` answers with the global `profiles` row instead,
  // which is what the specs assert on.
  _setTestGetProfiles(async () => []);
  // The Roomy profile record, however, IS stubbed — with the stub PDS's own
  // repo. A profile saved through the UI is a `space.roomy.user.profile/self`
  // record in the user's repo, and `getProfile` reads the PDS first because the
  // record is the authoritative source (a just-confirmed write must be visible
  // immediately, which a Jetstream-fed index cannot promise). With the PDS
  // replaced by a constant `null` that branch could never be reached, so a
  // saved profile would be unobservable and the write path untestable.
  // Reading the stub repo closes the loop: what the client wrote is what the
  // handler reads back, with no network involved.
  _setTestGetRoomyProfileRecord(async (did) => {
    const record = stubGetRecord(did, PROFILE_COLLECTION, PROFILE_RKEY);
    if (!record) return null;
    return record.value as RoomyProfileRecord;
  });
  // Message search runs against an in-process fake Qdrant, installed before
  // the factory builds its singletons: with no `QDRANT_URL` the search route
  // would answer 503 and the indexer would drop every job. The fake makes the
  // indexer, the backfill sweeper and `space.roomy.search.messages` behave as
  // they do in a Qdrant-backed deployment, without a service or a socket.
  const qdrant = new FakeQdrant();
  _setQdrantClientForTest(qdrant);

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
    // HappyView / arbiter / Polar are left unconfigured — each is a no-op
    // without its env vars. Qdrant is not: the fake above stands in for it.
  });

  const appserverOrigin = `http://127.0.0.1:${appserver.port}`;
  await waitForHttp(`${appserverOrigin}/health`, 20_000);

  // ── Fixtures ─────────────────────────────────────────────────────────
  await seedFixture(appserverOrigin);

  // The indexer drains asynchronously; wait for the seeded rows to be
  // searchable so the specs start against a warm index.
  await waitForSearchIndex(
    appserverOrigin,
    SEED_SEARCH_MESSAGE_TERM,
    SEED_SEARCH_MESSAGE_ID,
  );
  await waitForSearchIndex(
    appserverOrigin,
    SEED_SEARCH_THREAD_MESSAGE_TERM,
    SEED_SEARCH_THREAD_MESSAGE_ID,
  );

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
    _resetQdrantClient();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());

  // Block forever; Playwright kills this process when the run finishes.
  await new Promise<never>(() => {});
}

await main();
