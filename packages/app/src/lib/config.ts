export const CONFIG = {
  leafUrl: import.meta.env.VITE_LEAF_URL || "leaf-dev.muni.town",
  streamNsid: import.meta.env.VITE_STREAM_NSID || "space.roomy.stream.dev",
  streamSchemaVersion: "1",
  /** This must be changed every time the local database schema / materializer is changed. */
  moduleVersion: "1",
};
