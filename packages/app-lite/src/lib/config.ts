import { env as dynamicEnv } from "$env/dynamic/public";

const APPSERVER_RPCS = [
  "space.roomy.space.getSpaces",
  "space.roomy.space.getMetadata",
  "space.roomy.space.getSpaceSummary",
  "space.roomy.space.getThreads",
  "space.roomy.space.getRoles",
  "space.roomy.space.getMembers",
  "space.roomy.space.getInvites",
  "space.roomy.room.getMetadata",
  "space.roomy.room.getRoomSummary",
  "space.roomy.room.getMessages",
  "space.roomy.room.getThreads",
  "space.roomy.message.getMessage",
  "space.roomy.message.getReactions",
  "space.roomy.auth.getConnectionTicket",
  "space.roomy.getFlags",
  "space.roomy.room.updateSeen",
  "space.roomy.space.sendEvents",
  "space.roomy.space.createSpace",
  "space.roomy.space.joinSpace",
  "space.roomy.space.leaveSpace",
  "space.roomy.space.setHandle",
  "space.roomy.space.getCalendarLink",
  "space.roomy.space.getCalendarEvents",
  "space.roomy.space.getActivityFeed",
  // Web push notification endpoints
  "space.roomy.push.getVapidPublicKey",
  "space.roomy.push.getPreferences",
  "space.roomy.push.registerSubscription",
  "space.roomy.push.unregisterSubscription",
  "space.roomy.push.setPreferences",
];

export const CONFIG = {
  appserverDid:
    import.meta.env.VITE_APPSERVER_DID || "did:web:appserver.roomy.chat",
  /**
   * Override the WebSocket origin for the sync connection.
   * When set, bypasses DID document resolution and uses this URL directly.
   * Useful for local development: VITE_APPSERVER_WS_ORIGIN=ws://127.0.0.1:8080
   */
  appserverWsOrigin: import.meta.env.VITE_APPSERVER_WS_ORIGIN || null,
  /**
   * HTTP origin for direct XRPC calls (getMessages, updateSeen, …). In local
   * dev we derive it from the WS-origin override so a single
   * VITE_APPSERVER_WS_ORIGIN points BOTH the sync WebSocket and the XRPC HTTP
   * client at the local appserver. When unset, the HTTP origin is resolved
   * from the appserver DID (i.e. production).
   */
  appserverHttpOrigin:
    (import.meta.env.VITE_APPSERVER_WS_ORIGIN || "")
      .replace(/^ws(s?):\/\//, "http$1://")
      .replace(/\/+$/, "") || null,
  port: Number(import.meta.env.VITE_PORT) || 5180,
  usePublicClient: import.meta.env.VITE_OAUTH_PUBLIC_CLIENT === "true",
  profileSpaceNsid:
    import.meta.env.VITE_STREAM_HANDLE_NSID || "space.roomy.space.handle.dev",
  personalStreamNsid:
    import.meta.env.VITE_PERSONAL_STREAM_NSID || "space.roomy.space.personal.dev",
  personalStreamSchemaVersion:
    import.meta.env.VITE_PERSONAL_STREAM_SCHEMA_VERSION || "4",
  /** Test-mode app-password credentials (bake into env for headless E2E). */
  testIdentifier: dynamicEnv.PUBLIC_TEST_IDENTIFIER || null,
  testAppPassword: dynamicEnv.PUBLIC_TEST_APP_PASSWORD || null,
};

export const OAUTH_SCOPE = [
  "atproto",
  // Profile reads are public data; allow any appview (Bluesky, Blacksky,
  // Eurosky, etc.) so users whose PDS routes to a non-Bluesky appview can
  // still fetch profiles. lxm is pinned to the specific NSID, so this only
  // grants read access to these two endpoints — not a blanket appview grant.
  "rpc:app.bsky.actor.getProfiles?aud=*",
  "rpc:app.bsky.actor.getProfile?aud=*",
  "blob:*/*",
  "repo:space.roomy.upload.v0", // Grant all actions (create, update, delete)
  `repo:${CONFIG.profileSpaceNsid}`,
  `repo:${CONFIG.personalStreamNsid}`,
  // Allow calling getServiceAuth on the appserver's PDS to obtain
  // service auth tokens for direct (non-proxied) XRPC calls.
  `rpc:com.atproto.server.getServiceAuth?aud=${CONFIG.appserverDid}`,
  ...APPSERVER_RPCS.map((nsid) => `rpc:${nsid}?aud=*`),
].join(" ");
