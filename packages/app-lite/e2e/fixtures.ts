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
/** Sidebar category the seeded channels are placed under. */
export const SEED_SIDEBAR_CATEGORY_ID = "01M3C8QTVTHS4EJ1BQFG6JFE6M";

/** Seeded channel. */
export const SEED_ROOM_ID = "01M3C8QTVSVVMX7GTE7E3E659W";
export const SEED_ROOM_NAME = "lobby";

/**
 * Second channel in the same space. A navigation regression needs two rooms in
 * one space to distinguish "the room route re-ran" from "the sidebar/space
 * context was re-established".
 */
export const SEED_ROOM_2_ID = "01M3C8QTVS0000000000000002";
export const SEED_ROOM_2_NAME = "general";

/**
 * Second space, so a cross-space switch is expressible: the space layout is
 * reused across it and every module-level nav state must be replaced, not
 * merely left in place.
 */
export const SEED_SPACE_2_ID = "did:plc:e2espace2nd00000000000000";
export const SEED_SPACE_2_NAME = "E2E Second Space";
export const SEED_SPACE_2_CATEGORY_ID = "01M3C8QTVS0000000000000003";
export const SEED_SPACE_2_ROOM_ID = "01M3C8QTVS0000000000000004";
export const SEED_SPACE_2_ROOM_NAME = "second-space-lobby";

/**
 * Third space, where the test user is a plain member and another account is
 * the admin. Moderation surfaces are gated on author-or-admin, so expressing
 * "a message this viewer may not delete" needs a message authored by someone
 * else in a space the viewer does not administer — neither is expressible in
 * the two spaces above, where the test user is an admin and the only author.
 */
export const SEED_SPACE_3_ID = "did:plc:e2espace3rd00000000000000";
export const SEED_SPACE_3_NAME = "E2E Third Space";
export const SEED_SPACE_3_CATEGORY_ID = "01M3C8QTVS0000000000000005";
export const SEED_SPACE_3_ROOM_ID = "01M3C8QTVS0000000000000006";
export const SEED_SPACE_3_ROOM_NAME = "third-space-lobby";
/** The other account's message there, which the test user may not delete. */
export const SEED_SPACE_3_MESSAGE_TEXT = "another account's message";

/** The admin of the third space, and the author of its seeded message. */
export const OTHER_USER_DID = "did:plc:e2eotheruser000000000000";
export const OTHER_USER_HANDLE = "e2e.other.roomy.test";
export const OTHER_USER_DISPLAY_NAME = "E2E Other User";

/**
 * Fourth space, where the seeded user is a plain member and member-created
 * invites are disabled — the configuration the appserver refuses `getInvites`
 * for. Its own DID (rather than an extra membership in an existing space) so
 * the seeded user's admin status elsewhere cannot leak into it.
 */
export const SEED_MEMBER_SPACE_ID = "did:plc:e2ememberspace0000000000";
export const SEED_MEMBER_SPACE_NAME = "E2E Member Space";
export const SEED_MEMBER_SPACE_CATEGORY_ID = "01M3C8QTVS0000000000000007";
export const SEED_MEMBER_SPACE_ROOM_ID = "01M3C8QTVS0000000000000008";
export const SEED_MEMBER_SPACE_ROOM_NAME = "member-space-lobby";
export const SEED_MEMBER_SPACE_MESSAGE_TEXT =
  "seeded message in the member space";
/**
 * Second DID with membership in the member space, granted admin there. The
 * spec's request interceptor authenticates as it to prove the admin branch
 * still reads invites and still creates them.
 */
export const TEST_ADMIN_DID = "did:plc:e2etestadmin000000000000";
/**
 * Valid DID with no membership anywhere in the seeded world — the caller the
 * appserver refuses a write from. Used to drive a genuinely refused press.
 */
export const TEST_NON_MEMBER_DID = "did:plc:e2enonmember000000000000";

/** Seeded message, materialised through the real `sendEvents` write path. */
export const SEED_MESSAGE_ID = "01M3C8QTVSG74JEG1QBM3STVX1";
export const SEED_MESSAGE_TEXT = "seeded message from the e2e fixture";

/** Distinctive body for the second channel, so the two rooms are tellable apart. */
export const SEED_ROOM_2_MESSAGE_TEXT = "seeded message in the general channel";
/** Distinctive body for the second space's channel. */
export const SEED_SPACE_2_MESSAGE_TEXT =
  "seeded message in the second space";
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
/** Path to the second channel in the first space. */
export const SEED_ROOM_2_PATH = `/${SEED_SPACE_ID}/${SEED_ROOM_2_ID}`;
/** Path to the second space's channel. */
export const SEED_SPACE_2_ROOM_PATH = `/${SEED_SPACE_2_ID}/${SEED_SPACE_2_ROOM_ID}`;
/** Path to the third space's channel, where the viewer is a plain member. */
export const SEED_SPACE_3_ROOM_PATH = `/${SEED_SPACE_3_ID}/${SEED_SPACE_3_ROOM_ID}`;
/** Path to the member space's channel. */
export const SEED_MEMBER_SPACE_ROOM_PATH = `/${SEED_MEMBER_SPACE_ID}/${SEED_MEMBER_SPACE_ROOM_ID}`;
