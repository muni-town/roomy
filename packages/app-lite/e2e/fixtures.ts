/**
 * E2E fixture constants — shared by the stack launcher (Bun) and the specs
 * (Node/Playwright).
 *
 * Plain literals only, so both runtimes import this without a build step.
 * IDs are fixed rather than generated so specs can address routes directly.
 */

/** Origin the app-lite dev server is served from. */
export const APP_LITE_PORT = 5181;
export const APP_LITE_ORIGIN = `http://127.0.0.1:${APP_LITE_PORT}`;

/** Origin of the appserver booted in-process by the stack launcher. */
export const APPSERVER_PORT = 8181;
export const APPSERVER_HTTP_ORIGIN = `http://127.0.0.1:${APPSERVER_PORT}`;
export const APPSERVER_WS_ORIGIN = `ws://127.0.0.1:${APPSERVER_PORT}`;

/**
 * Appserver DID. Matches `scripts/dev-local`. Only used as the service-auth
 * token audience, which `testAuthVerifier` ignores.
 */
export const APPSERVER_DID = "did:web:localhost";

/**
 * Stand-in ATProto PDS, answering the two endpoints the client's test-mode
 * auth path calls (`com.atproto.server.createSession`,
 * `com.atproto.server.getServiceAuth`) so the real `AtpAgent` login runs with
 * no network and no real credentials.
 */
export const PDS_PORT = 4599;
export const PDS_ORIGIN = `http://127.0.0.1:${PDS_PORT}`;

/** Identity the stub PDS authenticates every login as; also the seeded user. */
export const TEST_USER_DID = "did:plc:e2etestuser000000000000";
export const TEST_USER_HANDLE = "e2e.roomy.test";
export const TEST_USER_DISPLAY_NAME = "E2E Tester";

/** Seeded space. */
export const SEED_SPACE_ID = "did:plc:e2espace0000000000000000";
export const SEED_SPACE_NAME = "E2E Test Space";
/** Sidebar category the seeded channel is placed under. */
export const SEED_SIDEBAR_CATEGORY_ID = "01M3C8QTVTHS4EJ1BQFG6JFE6M";

/** Seeded channel. */
export const SEED_ROOM_ID = "01M3C8QTVSVVMX7GTE7E3E659W";
export const SEED_ROOM_NAME = "lobby";

/** Seeded message, materialised through the real `sendEvents` write path. */
export const SEED_MESSAGE_ID = "01M3C8QTVSG74JEG1QBM3STVX1";
export const SEED_MESSAGE_TEXT = "seeded message from the e2e fixture";

/**
 * Origin of the Discord bridge REST surface. Nothing listens here: the spec
 * that covers the bridge settings page fulfils these requests itself, and
 * every other spec never reaches this page. Set on the app-lite dev server by
 * Playwright's `webServer.env`, because the panel reads it from
 * `$env/dynamic/public` at runtime.
 */
export const BRIDGE_PORT = 9998;
export const BRIDGE_ORIGIN = `http://127.0.0.1:${BRIDGE_PORT}`;

/** Path to the seeded channel. */
export const SEED_ROOM_PATH = `/${SEED_SPACE_ID}/${SEED_ROOM_ID}`;
