const CONFIG = {
  // service endpoints
  leafUrl: import.meta.env.VITE_LEAF_URL || "https://leaf-dev.muni.town",
  plcDirectory:
    (import.meta.env.VITE_PLC_DIRECTORY ||
      import.meta.env.PUBLIC_PLC_DIRECTORY ||
      "https://plc.directory") as string,
  faroEndpoint: (import.meta.env.VITE_FARO_ENDPOINT || undefined) as
    | string
    | undefined,

  // min log level for telemetry
  logLevel: import.meta.env.VITE_LOG_LEVEL || "info",

  // atproto collections and schema versions
  streamNsid:
    import.meta.env.VITE_STREAM_NSID || "space.roomy.space.personal.dev",
  streamHandleNsid:
    import.meta.env.VITE_STREAM_HANDLE_NSID || "space.roomy.space.handle.dev",
  streamSchemaVersion: "4" as const,
  databaseSchemaVersion: "3" as const,

  // testing credentials for auto-authentication in e2e tests
  testingHandle: import.meta.env.VITE_TESTING_HANDLE,
  testingAppPassword: import.meta.env.VITE_TESTING_APP_PASSWORD,

  // feature flags
  flags: {
    threadsList: true, // 'Index' (threads list) page for spaces
    discordImport: false,
    discordBridge: false,
    sharedWorker: false,
  },

  // placeholders overridden below
  leafServerDid: "",
  atprotoOauthScope: "",
};

CONFIG.leafServerDid = `did:web:${new URL(CONFIG.leafUrl).hostname}`;
CONFIG.atprotoOauthScope = [
  `atproto`, // Required just to login to atproto

  `rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview`, // Access to query the Bluesky profile

  // These are the scopes needed for accessing Bluesky DMs, but since we don't have the UI for that
  // yet, lets not ask for permission to it.

  // ...[
  //   "chat.bsky.actor.deleteAccount",
  //   "chat.bsky.actor.exportAccountData",
  //   "chat.bsky.convo.acceptConvo",
  //   "chat.bsky.convo.deleteMessageForSelf",
  //   "chat.bsky.convo.getConvoAvailability",
  //   "chat.bsky.convo.getConvoForMembers",
  //   "chat.bsky.convo.getConvo",
  //   "chat.bsky.convo.getLog",
  //   "chat.bsky.convo.leaveConvo",
  //   "chat.bsky.convo.listConvos",
  //   "chat.bsky.convo.muteConvo",
  //   "chat.bsky.convo.removeReaction",
  //   "chat.bsky.convo.sendMessageBatch",
  //   "chat.bsky.convo.unmuteConvo",
  //   "chat.bsky.convo.addReaction",
  //   "chat.bsky.convo.updateAllRead",
  //   "chat.bsky.convo.updateRead",
  //   "chat.bsky.moderation.getActorMetadata",
  //   "chat.bsky.moderation.getMessageContext",
  //   "chat.bsky.moderation.updateActorAccess",
  // ].map((lxm) => `rpc:${lxm}?aud=did:web:api.bsky.chat%23bsky_chat`),

  "blob:*/*", // Allow all blob uploads
  "repo:space.roomy.upload.v0", // And creating roomy upload records

  `repo:${CONFIG.streamNsid}`, // Access to the stream collection
  `repo:${CONFIG.streamHandleNsid}`, // Access to the stream handle collection

  // TODO: For some reason I can't get this to work with a non-wildcard audience. In the future we
  // should be able to set the audience to the `leafServerDid`.
  `rpc:town.muni.leaf.authenticate?aud=*`, // Access to authenticate to the leaf server
].join(" ");

/** Default feature flags, can be overridden per environment with
 * VITE_FEATURE_FLAGS env var as JSON string.
 */

type Flags = typeof CONFIG.flags;

function loadFlags(): Flags {
  const overrides = import.meta.env.VITE_FEATURE_FLAGS;
  if (!overrides) return CONFIG.flags;

  try {
    return { ...CONFIG.flags, ...JSON.parse(overrides) };
  } catch {
    console.warn("Invalid VITE_FEATURE_FLAGS JSON");
    return CONFIG.flags;
  }
}

export const flags = loadFlags();

export { CONFIG };
