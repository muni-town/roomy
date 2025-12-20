const CONFIG = {
  leafUrl: import.meta.env.VITE_LEAF_URL || "https://leaf-dev.muni.town",
  streamNsid: import.meta.env.VITE_STREAM_NSID || "space.roomy.stream.dev",
  streamHandleNsid:
    import.meta.env.VITE_STREAM_HANDLE_NSID || "space.roomy.stream.handle.dev",
  streamSchemaVersion: "2" as const,
  databaseSchemaVersion: "2" as const,
  leafServerDid: "",
  atprotoOauthScope: "",
  testingAppPassword: import.meta.env.VITE_TESTING_APP_PASSWORD,
  testingHandle: import.meta.env.VITE_TESTING_HANDLE,
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
  "repo:space.roomy.upload", // And creating roomy upload records

  `repo:${CONFIG.streamNsid}`, // Access to the stream collection
  `repo:${CONFIG.streamHandleNsid}`, // Access to the stream handle collection

  // TODO: For some reason I can't get this to work with a non-wildcard audience. In the future we
  // should be able to set the audience to the `leafServerDid`.
  `rpc:town.muni.leaf.authenticate?aud=*`, // Access to authenticate to the leaf server
].join(" ");

export { CONFIG };
