export const CONFIG = {
  leafUrl: import.meta.env.VITE_LEAF_URL || "leaf-dev.muni.town",
  streamNsid: import.meta.env.VITE_STREAM_NSID || "space.roomy.stream.dev",
  streamHandleNsid:
    import.meta.env.VITE_STREAM_HANDLE_NSID || "space.roomy.stream.handle.dev",
  streamSchemaVersion: "1",
  databaseSchemaVersion: "2",
  atprotoOauthScope: "atproto transition:generic transition:chat.bsky",
};
